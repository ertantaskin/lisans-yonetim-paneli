import { createHash, randomInt, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { CryptoService } from '../crypto/crypto.service';
import { RateLimitService } from '../common/rate-limit.service';
import { SitesService } from '../sites/sites.service';
import { auditLog, siteConnectTokens, sites } from '../db/schema';

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
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly rateLimit: RateLimitService,
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
    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + CONNECT_CODE_TTL_MS);
    // Token id UYGULAMADA üretilir: AAD onu bağlar (bkz. connectTokenAad) ve blob'ları
    // şifrelemeden ÖNCE id'nin bilinmesi gerekir. `license_items`/`sites` ile aynı desen.
    const tokenId = randomUUID();
    const aad = CryptoService.connectTokenAad(tokenId);

    // rekey + eski kod temizliği + yeni kod ekleme TEK transaction'da (§14 sertleştirme):
    // rekey site creds'ini yeniler; token INSERT'i herhangi bir nedenle başarısız olursa rekey
    // de GERİ ALINIR → site "yeni creds üretildi ama hiçbir koda gömülmedi/teslim edilmedi"
    // durumuna (yetim/lockout: eski api_key ölü, yeni api_key kimsede yok) DÜŞMEZ.
    // 404: site yoksa rekey içindeki getById fırlatır (transaction başında).
    await this.db.transaction(async (tx) => {
      const creds = await this.sites.rekey(siteId, tx);

      // Aynı sitenin eski (tüketilmemiş) kodları geçersiz — tek aktif kod kalsın.
      await tx
        .delete(siteConnectTokens)
        .where(and(eq(siteConnectTokens.siteId, siteId), isNull(siteConnectTokens.consumedAt)));

      // Tüketilmiş/süresi geçmiş ESKİ satırlarda blob KALMASIN (denetim bulgusu): rekey
      // yapıldığı için o creds artık ölü olsa da, hiç claim edilmemiş bir satır retention
      // penceresi (varsayılan 7 gün) boyunca O AN GEÇERLİ kimlik bilgilerini şifreli
      // tutuyordu. Silme yukarıdaki DELETE ile yalnız tüketilmemişleri kapsıyor; kalanların
      // blob'ları burada NULL'lanır (satır denetim izi olarak durur).
      await tx
        .update(siteConnectTokens)
        .set({ apiKeyEnc: null, hmacSecretEnc: null })
        .where(and(eq(siteConnectTokens.siteId, siteId), isNotNull(siteConnectTokens.apiKeyEnc)));

      await tx.insert(siteConnectTokens).values({
        id: tokenId,
        siteId,
        codeHash: hashCode(code),
        apiKeyEnc: this.crypto.encrypt(creds.apiKey, aad),
        hmacSecretEnc: this.crypto.encrypt(creds.hmacSecret, aad),
        expiresAt,
      });
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
    webhookUrl?: string,
  ): Promise<{ siteDomain: string; apiKey: string; hmacSecret: string }> {
    // IP başına kısa pencere rate-limit (brute-force önleme) — Redis sabit-pencere sayaç.
    if (!(await this.rateLimit.hit(`connect_claim:${ip}`, CLAIM_RL_MAX, CLAIM_RL_WINDOW_SEC))) {
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
      // Creds'i çöz (blob'lar hâlâ dolu) — null'lamadan ÖNCE.
      //
      /*
       * AAD TOKEN SATIRINA BAĞLI (`connect_token:<id>`) — GERİ DÜŞÜŞ YOK.
       *
       * NEDEN GERİ DÜŞÜŞ KALDIRILDI (denetim bulgusu — önceki düzeltme EKSİKTİ):
       * Eskiden yeni AAD patlayınca `catch` eski site AAD'sini (`site_secret:<siteId>`) deniyordu
       * ve bu, kapatılmak İSTENEN açığın ta kendisini AÇIK BIRAKIYORDU. Saldırı zinciri kodda
       * tamamen karşılanıyordu: `site_connect_tokens.site_id` düz uuid (FK YOK) → DB'ye YAZMA
       * erişimi olan biri `sites.hmac_secret_enc` blob'unu kendi eklediği bir token satırına
       * KOPYALAR, `expires_at`i kendi yazar, kimlik istemeyen `POST /v1/connect/claim`i çağırır.
       * Yeni AAD tutmaz → catch → eski AAD **blob'un gerçekten şifrelendiği AAD'dir** → çözülür
       * → sitenin DÜZ METİN `hmac_secret`i yanıtta döner. Sonrasında site-facing her uç (düz
       * metin lisans döndüren `GET /orders/:id/deliveries` dahil) imzalanabilir — hem de
       * MASTER_KEY hiç ele geçirilmeden. Geri düşüş KOŞULSUZ olduğu için "kodlar 15 dakikada
       * ölür" gerekçesi saldırganı bağlamıyordu: `expires_at`i o yazıyor, dal asla ölmüyordu.
       *
       * GERİYE DÖNÜK ETKİ YOK: bağlan kodlarının ömrü 15 dakika; token AAD'sine geçiş bundan
       * çok daha önce dağıtıldı, yani eski ad alanıyla şifrelenmiş HİÇBİR meşru kod artık
       * geçerli değil. Böyle bir satır yine de gelirse çözme başarısız olur ve aşağıdaki
       * `catch` bunu 400 + GÖRÜNÜR log ile bildirir (sessiz kabul yerine gürültülü ret).
       */
      const decryptCreds = (): { apiKey: string; hmacSecret: string } => {
        const tokenAad = CryptoService.connectTokenAad(token.id);
        try {
          return {
            apiKey: this.crypto.decrypt(token.apiKeyEnc!, tokenAad),
            hmacSecret: this.crypto.decrypt(token.hmacSecretEnc!, tokenAad),
          };
        } catch {
          // Bu satır artık bir SALDIRI SİNYALİDİR (meşru kod bu dala düşemez): ya blob başka bir
          // ad alanıyla şifrelendi ya da satır elle enjekte edildi. SIR yazılmaz.
          this.logger.error(
            `Bağlan kodu kendi AAD ad alanıyla ÇÖZÜLEMEDİ — istek reddedildi ` +
              `(token=${token.id}, site=${token.siteId}). Elle eklenmiş/taşınmış satır olabilir.`,
          );
          throw new BadRequestException('Bağlan kodu geçersiz.');
        }
      };
      const { apiKey, hmacSecret } = decryptCreds();

      // Atomik tek-kullanım: consumedAt hâlâ null iken tüket; yarışta 0 satır → reddet.
      const consumed = await tx
        .update(siteConnectTokens)
        .set({ consumedAt: new Date(), apiKeyEnc: null, hmacSecretEnc: null })
        .where(and(eq(siteConnectTokens.id, token.id), isNull(siteConnectTokens.consumedAt)))
        .returning({ id: siteConnectTokens.id });

      if (consumed.length === 0) throw new NotFoundException('Kod geçersiz veya süresi dolmuş');

      // Geri-kanal webhook adresini (WP eklentisi kendi rest_url'ini gönderir) siteye yaz →
      // connect-kod akışıyla kurulan sitede webhook GERÇEKTEN bağlanır. HOST DOĞRULAMA: yalnız
      // webhook host'u sitenin domain'iyle eşleşiyorsa yazılır (yanlış-yönlendirme/SSRF koruması).
      // Eşleşmezse claim BOZULMAZ — creds yine teslim edilir, yalnız webhook otomatik bağlanmaz
      // (admin panelden elle set edebilir). Kod tek-kullanımlık+kısa ömürlü+rate-limitli.
      if (webhookUrl && hostMatchesSite(webhookUrl, site.domain)) {
        await tx
          .update(sites)
          .set({ webhookUrl, updatedAt: new Date() })
          .where(eq(sites.id, token.siteId));
      }
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

/**
 * Webhook URL host'u sitenin kayıtlı domain'iyle uyumlu mu (connect claim otomatik-webhook
 * güvenlik kapısı). Karşılaştırma şema/yol/www-bağımsız; alt-alan adları da kabul edilir
 * (site prod.example.com iken webhook example.com veya tersinde). Geçersiz URL → false.
 */
function hostMatchesSite(webhookUrl: string, siteDomain: string): boolean {
  const norm = (h: string) =>
    h
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/[/?#].*$/, '')
      .replace(/:\d+$/, '')
      .replace(/^www\./, '');
  try {
    const host = norm(new URL(webhookUrl).hostname);
    const dom = norm(siteDomain);
    if (!host || !dom) return false;
    // Yalnız AYNI alan adı veya sitenin ALT alan adı kabul edilir. ÜST/ATA alan adı (eski
    // `dom.endsWith('.'+host)` dalı) KALDIRILDI: çok-kiracılı bir kurulumda site
    // shop.tenant.example.com iken webhook'un paylaşılan ata alan adına (example.com)
    // yazılmasına izin veriyordu. store-admin-url'deki daraltılmış mantıkla birebir hizalı.
    return host === dom || host.endsWith(`.${dom}`);
  } catch {
    return false;
  }
}
