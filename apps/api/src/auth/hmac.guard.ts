import { createHash, createHmac } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type Redis from 'ioredis';
import { Inject } from '@nestjs/common';
import {
  HMAC_HEADERS,
  HMAC_NONCE_TTL_SEC,
  HMAC_TIMESTAMP_TOLERANCE_SEC,
  buildSignaturePayload,
} from '@lisans/shared';
import { CryptoService } from '../crypto/crypto.service';
import { REDIS } from '../redis/redis.module';
import { SitesService } from '../sites/sites.service';
import type { Site } from '../db/schema';

/** Kurulu WP eklenti sürümü — İMZA KAPSAMI DIŞINDA (bkz. HmacGuard.recordPluginVersion). */
const PLUGIN_VERSION_HEADER = 'x-wpteslimat-version';

/** Katı `N.N.N` — uymayan değer sessizce yok sayılır. */
const PLUGIN_VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Request'e iliştirilen doğrulanmış site (controller'lar @CurrentSite ile alır). */
export interface AuthedRequest extends FastifyRequest {
  site?: Site;
  /** NestFactory rawBody:true ile eklenir — HMAC gövde hash'i için. */
  rawBody?: Buffer;
}

/**
 * HMAC imza guard'ı (MIMARI.md §4). Site-facing tüm v1 uçlarını korur.
 *
 *   X-Signature = HMAC-SHA256(secret, METHOD\nPATH\nTS\nNONCE\nSHA256(body))
 *
 * - Timestamp ±300sn (saat kayması)
 * - Nonce Redis'te 10dk tekil (replay engeli)
 * - api_key hash'ten site bulunur, hmac_secret çözülür, imza sabit-zamanlı karşılaştırılır
 */
@Injectable()
export class HmacGuard implements CanActivate {
  constructor(
    private readonly sites: SitesService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const h = req.headers;

    const apiKey = str(h[HMAC_HEADERS.apiKey]);
    const timestamp = str(h[HMAC_HEADERS.timestamp]);
    const nonce = str(h[HMAC_HEADERS.nonce]);
    const signature = str(h[HMAC_HEADERS.signature]);

    if (!apiKey || !timestamp || !nonce || !signature) {
      throw new UnauthorizedException('Eksik imza başlıkları');
    }

    // 1) Zaman penceresi
    const now = Math.floor(Date.now() / 1000);
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > HMAC_TIMESTAMP_TOLERANCE_SEC) {
      throw new UnauthorizedException('İmza zaman penceresi dışında');
    }

    // 2) Site + secret
    const auth = await this.sites.findForAuth(apiKey);
    if (!auth) throw new UnauthorizedException('Geçersiz API anahtarı');

    // 3) İmza doğrula
    const bodyHash = createHash('sha256')
      .update(req.rawBody ?? Buffer.alloc(0))
      .digest('hex');
    const payload = buildSignaturePayload({
      method: req.method,
      path: req.url,
      timestamp,
      nonce,
      bodySha256Hex: bodyHash,
    });
    // Rotasyon: kabul edilen secret'lardan (güncel + zarafet penceresindeki eski)
    // herhangi biri imzayı doğruluyorsa geçerli. safeEqual sabit-zamanlı.
    const valid = auth.hmacSecrets.some((secret) => {
      const expected = createHmac('sha256', secret).update(payload).digest('hex');
      return CryptoService.safeEqual(signature, expected);
    });
    if (!valid) {
      throw new UnauthorizedException('Geçersiz imza');
    }

    // 4) Nonce tekilliği (imza geçerliyse harcanır → replay engeli)
    const nonceKey = `nonce:${auth.site.id}:${nonce}`;
    const set = await this.redis.set(nonceKey, '1', 'EX', HMAC_NONCE_TTL_SEC, 'NX');
    if (set !== 'OK') throw new UnauthorizedException('Nonce tekrar kullanıldı (replay)');

    // 5) Kurulu eklenti sürümünü kaydet (yalnız kimliği KANITLANMIŞ site için — imza
    //    doğrulandıktan SONRA). Best-effort telemetri; istek yolunu bloklamaz.
    this.recordPluginVersion(auth.site, str(h[PLUGIN_VERSION_HEADER]));

    req.site = auth.site;
    return true;
  }

  /**
   * `x-wpteslimat-version` başlığından sitenin KURULU eklenti sürümünü öğrenir (0028) →
   * panelde "hangi site hangi sürümde" görünürlüğü.
   *
   * GÜVENLİK NOTU: bu başlık İMZA KAPSAMINDA DEĞİLDİR (`x-wp-actor` ile aynı sınıf) —
   * imzalanan payload yalnız method/path/timestamp/nonce/body hash'idir. Yani değer
   * istemci-beyanıdır, doğrulanmamıştır. YALNIZ gösterim/telemetri amaçlıdır; hiçbir
   * yetki/erişim/davranış kararı buna dayandırılmaz. En kötü hâlde site kendi satırında
   * yanlış bir sürüm etiketi gösterir (sır sızmaz, ayrıcalık kazanılmaz).
   *
   * Yazım kuralları:
   * - Yalnız katı semver-benzeri `N.N.N` kabul edilir; aksi hâlde YOK SAYILIR (çöp/enjeksiyon yok).
   * - Değer DEĞİŞMEDİYSE yazılmaz — her HMAC isteğinde UPDATE atmak sıcak yolu yavaşlatırdı.
   * - Fire-and-forget: await EDİLMEZ (istek beklemez) ama `.catch` ile yutulur →
   *   unhandled rejection bırakmaz ve DB hatası isteği ASLA düşürmez.
   */
  private recordPluginVersion(site: Site, version: string | undefined): void {
    try {
      if (!version || !PLUGIN_VERSION_RE.test(version)) return;
      if (site.pluginVersion === version) return;
      void this.sites.recordPluginVersion(site.id, version).catch(() => {});
    } catch {
      // Telemetri hiçbir koşulda kimlik doğrulamayı bozmaz.
    }
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
