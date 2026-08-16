import { createHash, createHmac } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import type Redis from 'ioredis';
import { Inject, Logger } from '@nestjs/common';
import {
  HMAC_HEADERS,
  HMAC_NONCE_TTL_SEC,
  HMAC_TIMESTAMP_TOLERANCE_SEC,
  buildSignaturePayload,
} from '@lisans/shared';
import { CryptoService } from '../crypto/crypto.service';
import { RateLimitService } from '../common/rate-limit.service';
import { REDIS } from '../redis/redis.module';
import { SITE_LAST_SEEN_THROTTLE_SEC, SitesService } from '../sites/sites.service';
import type { Site } from '../db/schema';

/**
 * Site-facing auth başarısızlığında dönen TEK mesaj.
 *
 * Ayrı mesajlar ('Geçersiz API anahtarı' ↔ 'Geçersiz imza') secret bilinmeden bir api_key'in
 * KAYITLI olduğunu, sitenin AKTİF olduğunu ve rotasyon grace penceresinin hâlâ AÇIK olduğunu
 * tek istekte doğruluyordu — sızmış bir anahtar listesinden canlı olanları elemeye yarayan
 * ücretsiz bir oracle. Ayrım LOG'da kalır (aşağıdaki debug satırları; operatör teşhis
 * edebilir), yanıtta kalmaz.
 */
const AUTH_FAIL_MESSAGE = 'Kimlik doğrulama başarısız';

/** Kurulu WP eklenti sürümü — İMZA KAPSAMI DIŞINDA (bkz. HmacGuard.recordPluginVersion). */
const PLUGIN_VERSION_HEADER = 'x-wpteslimat-version';

/** Katı `N.N.N` — uymayan değer sessizce yok sayılır. */
const PLUGIN_VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * IP başına dakikalık BAŞARISIZ kimlik-doğrulama tavanı. YALNIZ auth-FAIL (geçersiz api_key ya da
 * geçersiz imza) sayılır — imzası her zaman geçerli olan bir mağazanın KENDİ istekleri sayacı ASLA
 * artırmaz. Amaç yalnız geçersiz-imza selinin `findForAuth` DB lookup'ıyla havuzu tüketmesini
 * önlemek: bir IP bu kadar başarısızlığa ulaşınca sonraki istekleri DB'ye HİÇ inmeden (peek) 429 yer.
 *
 * KOVANIN BİRİMİ **IP**'DİR, SİTE DEĞİL (`hmacfail:ip:<ip>`) ve peek imza doğrulanmadan ÖNCE
 * uygulanır. Bu yüzden "meşru trafik HİÇ kısıtlanmaz" güvencesi yalnız KENDİ isteklerin için
 * geçerlidir; ÇIKIŞ IP'Sİ PAYLAŞILAN kurulumlarda (paylaşımlı hosting, NAT'lı ofis/veri merkezi,
 * ortak çıkışlı CDN/proxy) YANLIŞ YAPILANDIRILMIŞ TEK BİR mağaza (ör. rotasyondan sonra eski
 * secret'la imzalayan bir kurulum) dakikada bu tavana ulaşırsa AYNI IP'deki HATASIZ mağazalar da
 * 429 alır ve siparişleri panele düşmez. Belirti mağaza tarafında görünür (401/429 → retry),
 * panelde ise "o siteden istek gelmiyor" olarak okunur — operatör sebebi burada aramaz.
 * Bu bilinçli bir denge: kova siteye bağlanamaz, çünkü peek'in AMACI DB lookup'ından (yani
 * sitenin çözülmesinden) ÖNCE karar vermektir. Tavan bu yüzden cömert seçildi (120/dk) ve
 * `HMAC_IP_FAIL_LIMIT` ile yükseltilebilir; meşru mağaza normalde 0 başarısızlık üretir.
 */
const HMAC_IP_FAIL_DEFAULT = 120;
/** IP başarısızlık penceresi (saniye). Retry-After da bu değerdir. */
const HMAC_IP_FAIL_WINDOW_SEC = 60;

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
 * - Nonce Redis'te `HMAC_NONCE_TTL_SEC` (= 2×tolerans + 60 = 660sn) boyunca tekil (replay engeli).
 *   Değer paylaşılan sözleşmeden gelir; "10dk" (600sn) yazmak 2×tolerans'a EŞİT olduğu için
 *   nonce'un replay penceresini kapsama invaryantını sınır kenarında bozan bir sayıyı
 *   normalleştirirdi (bkz. packages/shared/src/api/hmac.ts).
 * - api_key hash'ten site bulunur, hmac_secret çözülür, imza sabit-zamanlı karşılaştırılır
 */
@Injectable()
export class HmacGuard implements CanActivate {
  private readonly logger = new Logger(HmacGuard.name);

  constructor(
    private readonly sites: SitesService,
    @Inject(REDIS) private readonly redis: Redis,
    // IP hız-sınırı (fail-fast dayanıklılık partisi) için. @Optional + `?`: üretimde @Global
    // RateLimitModule + ConfigModule'den DI ile HER ZAMAN enjekte edilir; birim testleri guard'ı
    // 2-arg elle new'ler → undefined kalır ve IP-limit adımı GÜVENLE atlanır (davranış-nötr).
    @Optional() private readonly rateLimit?: RateLimitService,
    @Optional() private readonly config?: ConfigService,
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

    // 1.5) IP başarısızlık-tavanı — DB findForAuth lookup'ından ÖNCE PEEK (§4/§16 dayanıklılık).
    //   Geçersiz-imza seli her istekte bir DB lookup (+ havuz slotu) harcar. Sayaç YALNIZ auth-FAIL'de
    //   artar (aşağıda), burada yalnız BAKILIR (peek, sayaç artmaz): bir IP zaten cezalıysa DB'ye
    //   HİÇ inmeden 429 yer. Meşru mağaza (imzası geçerli) hiç başarısızlık üretmez → sayacı 0 kalır →
    //   ASLA kısıtlanmaz (eski "tüm istekleri say" tasarımı yoğun mağazayı yanlışlıkla 429'luyordu).
    //   IP kaynağı @Ip() ile aynı: Fastify `req.ip` (trustProxy=1 → spoof yok). Redis hatasında
    //   peekOverLimit fail-OPEN (false) → engellemez; nonce adımı yine de fail-closed olur.
    const ip = str((req as { ip?: string }).ip) ?? 'unknown';
    const failKey = `hmacfail:ip:${ip}`;
    const failLimit = this.ipFailLimit();
    if (this.rateLimit && (await this.rateLimit.peekOverLimit(failKey, failLimit))) {
      this.tooManyRequests(context);
    }

    // 2) Site + secret. Bulunamazsa auth-FAIL → IP sayacını artır (sel koruması) ve 401.
    const auth = await this.sites.findForAuth(apiKey);
    if (!auth) {
      await this.recordAuthFailure(failKey, failLimit);
      // MESAJ BİLEREK AYNI (denetim bulgusu): 'Geçersiz API anahtarı' ile 'Geçersiz imza'
      // ayrımı, secret bilinmeden bir api_key'in KAYITLI + sitenin AKTİF + rotasyon grace'inin
      // hâlâ AÇIK olduğunu tek istekte doğruluyordu (sızmış anahtar listesini eleme oracle'ı).
      this.logger.debug('auth-fail: api_key kayıtlı değil / site pasif');
      throw new UnauthorizedException(AUTH_FAIL_MESSAGE);
    }

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
      // auth-FAIL (geçerli api_key ama yanlış imza) → IP sayacını artır (sel koruması) ve 401.
      await this.recordAuthFailure(failKey, failLimit);
      this.logger.debug('auth-fail: imza uyuşmadı (api_key geçerli)');
      throw new UnauthorizedException(AUTH_FAIL_MESSAGE);
    }

    // 4) Nonce tekilliği (imza geçerliyse harcanır → replay engeli).
    //   Redis erişilemezse (donma/OOM) fail-CLOSED-FAST: nonce bir GÜVENLİK kontrolüdür (replay);
    //   doğrulanamıyorsa isteği REDDET (askıda BEKLEME). redis.commandTimeout=2000 sayesinde SET en
    //   geç ~2sn'de reject eder → 12sn'lik askıda kalma biter. WP tarafı 503'ü retry eder (veri
    //   kaybı yok). NOT: idempotency anahtarı (site+order+line) çifte-atamayı zaten önler; yine de
    //   güvenli tarafta kalıp reddediyoruz (replay penceresini doğrulayamadan geçirmeyiz).
    const nonceKey = `nonce:${auth.site.id}:${nonce}`;
    let set: string | null;
    try {
      set = await this.redis.set(nonceKey, '1', 'EX', HMAC_NONCE_TTL_SEC, 'NX');
    } catch {
      throw new ServiceUnavailableException('Servis geçici olarak kullanılamıyor');
    }
    if (set !== 'OK') throw new UnauthorizedException('Nonce tekrar kullanıldı (replay)');

    // 5) Kurulu eklenti sürümünü kaydet (yalnız kimliği KANITLANMIŞ site için — imza
    //    doğrulandıktan SONRA). Best-effort telemetri; istek yolunu bloklamaz.
    this.recordPluginVersion(auth.site, str(h[PLUGIN_VERSION_HEADER]));

    // 6) CANLILIK damgası (0040) — "bu mağaza hâlâ konuşuyor mu?". Aynı sınıf best-effort
    //    telemetri; İMZA DOĞRULANDIKTAN SONRA yazılır (aşağıdaki gerekçeye bak).
    this.recordLastSeen(auth.site);

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

  /**
   * Sitenin CANLILIK damgasını (`sites.last_seen_at`, 0040) tazeler → "mağaza sessiz mi?"
   * alarmının ve panel rozetlerinin TEK veri kaynağı.
   *
   * NEDEN İMZADAN SONRA (güvenlik): bu çağrı adım 3-4'ten (imza + nonce) SONRA yapılır.
   * Doğrulanmamış bir istek canlılık üretebilseydi, sitenin api_key'ini bilen (ya da yalnız
   * uydurma imza gönderen) herhangi biri ölü bir mağazayı "canlı" gösterip alarmı susturabilirdi
   * — yani sinyalin saldırgan tarafından kapatılabilir olması, hiç sinyal olmamasından beterdi
   * (operatör artık "alarm yok" diye güvenirdi).
   *
   * THROTTLE: `SITE_LAST_SEEN_THROTTLE_SEC` (60 sn) içinde yeniden yazılmaz. Burada bayat
   * `req.site` anlık görüntüsüyle ÖN eleme yapılır (UPDATE hiç gönderilmez); asıl güvence
   * SQL'deki aynı koşuldur (`SitesService.recordLastSeen`) — eşzamanlı istekler aynı bayat
   * görüntüyü paylaşabilir.
   *
   * Fire-and-forget: await EDİLMEZ (istek beklemez) ama `.catch` ile yutulur → unhandled
   * rejection bırakmaz ve DB hatası isteği ASLA düşürmez (recordPluginVersion deseni).
   */
  private recordLastSeen(site: Site): void {
    try {
      const last = site.lastSeenAt ? site.lastSeenAt.getTime() : 0;
      if (Date.now() - last < SITE_LAST_SEEN_THROTTLE_SEC * 1000) return;
      void this.sites.recordLastSeen(site.id).catch(() => {});
    } catch {
      // Telemetri hiçbir koşulda kimlik doğrulamayı bozmaz.
    }
  }

  /**
   * IP başına pencere içi BAŞARISIZ auth tavanı. Env `HMAC_IP_FAIL_LIMIT` geçerli pozitif sayıysa
   * onu, aksi halde varsayılanı (120) kullanır. Meşru mağaza hiç başarısızlık üretmediği için bu
   * değer yalnız saldırgan/yanlış-yapılandırılmış istemciyi etkiler; cömert tutulur.
   */
  private ipFailLimit(): number {
    const raw = this.config?.get<string>('HMAC_IP_FAIL_LIMIT');
    const n = raw != null ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : HMAC_IP_FAIL_DEFAULT;
  }

  /** auth-FAIL sayacını bir artırır (yalnız gerçek başarısızlıkta çağrılır). Best-effort. */
  private async recordAuthFailure(failKey: string, failLimit: number): Promise<void> {
    if (!this.rateLimit) return;
    // hit sayacı artırır; dönüşü burada önemsiz (bloklamayı bir SONRAKİ isteğin peek'i yapar).
    await this.rateLimit.hit(failKey, failLimit, HMAC_IP_FAIL_WINDOW_SEC);
  }

  /** 429 + Retry-After üretir (tekrar-suçlu IP peek ile yakalandığında). */
  private tooManyRequests(context: ExecutionContext): never {
    const res = context.switchToHttp().getResponse<{ header?: (k: string, v: string) => void }>();
    res.header?.('retry-after', String(HMAC_IP_FAIL_WINDOW_SEC));
    throw new HttpException('Çok fazla başarısız istek', HttpStatus.TOO_MANY_REQUESTS);
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
