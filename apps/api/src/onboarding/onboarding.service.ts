import { createHash, randomInt } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { DB, type Database } from '../db/db.module';
import { CryptoService } from '../crypto/crypto.service';
import { REDIS } from '../redis/redis.module';
import { SitesService } from '../sites/sites.service';
import { auditLog, siteConnectTokens } from '../db/schema';

/** Bağlan kodu geçerlilik süresi (§14 "tek seferlik 15dk kod"). */
const CONNECT_CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Karıştırılmayan kod alfabesi: A-Z2-9, ama görsel olarak karışan 0/O/1/I HARİÇ.
 * Tam 32 karakter → karakter başına 5 bit; 10 karakterlik kod ≈ 50 bit entropi.
 */
const CONNECT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** claim() IP başına rate-limit (kısa pencere brute-force önleme). */
const CLAIM_RL_WINDOW_SEC = 60;
const CLAIM_RL_MAX = 10;

/**
 * OnboardingService — WP site operatörünün paneli tek-seferlik kısa kodla bağlaması (§14).
 *
 * issueConnectCode: siteye taze creds üretir (rekey) ve kısa ömürlü, tek-kullanımlık,
 * yüksek-entropili bir kod arkasında şifreli tutar; koddan yalnız hash saklanır.
 * claim: kod karşılığında creds'i BİR KEZ teslim eder ve şifreli kopyayı hemen siler.
 * Kod dışında hiçbir sır loglanmaz.
 */
@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly crypto: CryptoService,
    private readonly sites: SitesService,
  ) {}

  /**
   * Site için tek-seferlik bağlan kodu üretir (§14). Önce site creds'i yenilenir (rekey)
   * → koda gömülen api_key/hmac_secret tazedir ve eski creds anında geçersizleşir. Aynı
   * sitenin önceki TÜKETİLMEMİŞ kodları silinir (tek aktif kod). Kod 15dk sonra dolar.
   * Yalnız {code, expiresAt} döner — creds burada DÖNMEZ (yalnız şifreli saklanır, claim'de teslim).
   */
  async issueConnectCode(siteId: string): Promise<{ code: string; expiresAt: Date }> {
    // 404: site yoksa rekey içindeki getById fırlatır.
    const creds = await this.sites.rekey(siteId);

    // Aynı sitenin eski (tüketilmemiş) kodları geçersiz — tek aktif kod kalsın.
    await this.db
      .delete(siteConnectTokens)
      .where(and(eq(siteConnectTokens.siteId, siteId), isNull(siteConnectTokens.consumedAt)));

    const code = this.generateCode();
    const aad = CryptoService.siteSecretAad(siteId);
    const expiresAt = new Date(Date.now() + CONNECT_CODE_TTL_MS);

    await this.db.insert(siteConnectTokens).values({
      siteId,
      codeHash: hashCode(code),
      apiKeyEnc: this.crypto.encrypt(creds.apiKey, aad),
      hmacSecretEnc: this.crypto.encrypt(creds.hmacSecret, aad),
      expiresAt,
    });

    await this.writeAudit(siteId, 'connect_issue');

    // NOT: creds (api_key/hmac_secret) BİLEREK loglanmaz/dönülmez — yalnız kod döner.
    return { code, expiresAt };
  }

  /**
   * Kodu tüketir ve site domain + creds'i BİR KEZ döndürür (§14). IP başına rate-limit;
   * kod geçerli+tüketilmemiş+süresi dolmamış+creds mevcut olmalı. Tüketim atomiktir
   * (consumedAt IS NULL koşullu UPDATE) → eşzamanlı iki claim'de yalnız biri kazanır.
   * Teslimden hemen sonra şifreli creds DB'den silinir (api_key_enc/hmac_secret_enc → null).
   */
  async claim(
    code: string,
    ip: string,
  ): Promise<{ siteDomain: string; apiKey: string; hmacSecret: string }> {
    // IP başına kısa pencere rate-limit (brute-force önleme). İlk artışta TTL kur.
    const rlKey = `connect_claim_rl:${ip}`;
    const hits = await this.redis.incr(rlKey);
    if (hits === 1) await this.redis.expire(rlKey, CLAIM_RL_WINDOW_SEC);
    if (hits > CLAIM_RL_MAX) {
      throw new HttpException(
        'Çok fazla deneme. Bir dakika sonra tekrar deneyin.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const [token] = await this.db
      .select()
      .from(siteConnectTokens)
      .where(
        and(
          eq(siteConnectTokens.codeHash, hashCode(code)),
          isNull(siteConnectTokens.consumedAt),
          gt(siteConnectTokens.expiresAt, sql`now()`),
          isNotNull(siteConnectTokens.apiKeyEnc),
        ),
      )
      .limit(1);

    if (!token) throw new NotFoundException('Kod geçersiz veya süresi dolmuş');

    // Sıra ÖNEMLİ: HATA verebilecek doğrulama/aramalar (domain için getById — site
    // yoksa fırlatır) ATOMIK tüketimden ÖNCE yapılır. Aksi halde arama, tek-kullanımlık
    // kod tüketildikten SONRA patlarsa kod yanar ve rekeylenen creds telafisiz kaybolur.
    // Tüketim yalnız her şey geçerliyken gerçekleşir.
    const site = await this.sites.getById(token.siteId); // domain için (fırlatabilir)

    const creds = await this.db.transaction(async (tx) => {
      const aad = CryptoService.siteSecretAad(token.siteId);
      // Creds'i çöz (blob'lar hâlâ dolu) — null'lamadan ÖNCE.
      const apiKey = this.crypto.decrypt(token.apiKeyEnc!, aad);
      const hmacSecret = this.crypto.decrypt(token.hmacSecretEnc!, aad);

      // Atomik tek-kullanım: consumedAt hâlâ null iken tüket; yarışta 0 satır → reddet.
      const consumed = await tx
        .update(siteConnectTokens)
        .set({ consumedAt: new Date(), apiKeyEnc: null, hmacSecretEnc: null })
        .where(and(eq(siteConnectTokens.id, token.id), isNull(siteConnectTokens.consumedAt)))
        .returning({ id: siteConnectTokens.id });

      if (consumed.length === 0) throw new NotFoundException('Kod geçersiz veya süresi dolmuş');
      return { apiKey, hmacSecret };
    });

    await this.writeAudit(token.siteId, 'connect_claim');

    return { siteDomain: site.domain, apiKey: creds.apiKey, hmacSecret: creds.hmacSecret };
  }

  /** Karıştırılmayan alfabeden yansız (randomInt) 10 karakter → XXXXX-XXXXX. */
  private generateCode(): string {
    let out = '';
    for (let i = 0; i < 10; i++) {
      if (i === 5) out += '-';
      out += CONNECT_CODE_ALPHABET[randomInt(CONNECT_CODE_ALPHABET.length)];
    }
    return out;
  }

  /**
   * Onboarding olayını audit_log'a yazar (§9). En iyi çaba: audit yazımı başarısız olsa
   * bile ana akış (kod üret/claim) BOZULMAZ. Sır (api_key/hmac_secret) meta'ya ASLA girmez.
   */
  private async writeAudit(siteId: string, op: 'connect_issue' | 'connect_claim'): Promise<void> {
    try {
      await this.db.insert(auditLog).values({
        action: 'site_update',
        actor: 'panel:admin',
        targetType: 'site',
        targetId: siteId,
        meta: { op },
      });
    } catch {
      // Audit best-effort — ana akışı bozma.
    }
  }
}

/**
 * Bağlan kodu → sha256 hex. Ham kod DB'de durmaz. İnsan-girişine dayanıklı olması için
 * önce normalize edilir: büyük harfe çevrilir ve alfabe dışı karakterler (tire, boşluk)
 * atılır → aynı kod farklı biçimde girilse de (kopyala/yapıştır) aynı hash'e düşer.
 */
function hashCode(code: string): string {
  const normalized = code
    .toUpperCase()
    .split('')
    .filter((c) => CONNECT_CODE_ALPHABET.includes(c))
    .join('');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
