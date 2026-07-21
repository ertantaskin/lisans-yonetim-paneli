import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gte, or, sql } from 'drizzle-orm';
import { HMAC_KEY_ROTATION_GRACE_SEC, type SiteType } from '@jetlisans/shared';
import { DB, type Database } from '../db/db.module';
import { CryptoService } from '../crypto/crypto.service';
import { auditLog, orders, siteProductMappings, sites, type Site } from '../db/schema';

export interface CreatedSite {
  id: string;
  domain: string;
  /** Yalnız oluşturmada bir kez döner; sonra saklanmaz (hash tutulur). */
  apiKey: string;
  /** Yalnız oluşturmada bir kez döner (şifreli saklanır). */
  hmacSecret: string;
}

/** Site 360 detayı (§8/§14) — SIR (hmac_secret/api_key) İÇERMEZ. */
export interface SiteDetail {
  site: {
    id: string;
    domain: string;
    type: string;
    status: string;
    senderEmail: string | null;
    /** Geri kanal webhook hedefi (§2) — null = webhook devre dışı. SIR değil. */
    webhookUrl: string | null;
    salesDailyQuota: number | null;
    /** Dinamik kota (§8) açık mı — açıksa eşik aşımında sipariş held_for_review'e alınır. */
    dynamicQuotaEnabled: boolean;
    /** Dinamik eşik çarpanı (§8): 30g-ortalama × bu değer. */
    reviewMultiplier: number;
    sandbox: boolean;
    createdAt: string;
  };
  /** Aktif ürün eşleme sayısı (site_product_mappings). */
  mappingCount: number;
  /** Bu siteden bugüne dek push edilmiş toplam sipariş sayısı. */
  orderCount: number;
  /** Bugünkü sipariş sayısı — SalesQuotaGuard ile AYNI pencere (kota kullanımı). */
  todayOrderCount: number;
  recentOrders: Array<{ id: string; remoteOrderId: string; status: string; createdAt: string }>;
}

/** Bağlantı sağlık teşhisi (onboarding) — tek bir kontrol satırı. SIR İÇERMEZ. */
export interface ConnectionCheck {
  /** Kontrolün adı (ör. 'HMAC secret'). */
  name: string;
  /** Kontrol geçti mi. */
  ok: boolean;
  /** İnsan-okunur ayrıntı (sır sızdırmaz). */
  detail: string;
}

/** POST /v1/admin/sites/:id/test-connection yanıtı. Genel `ok` = tüm check'ler geçti. */
export interface ConnectionTestResult {
  ok: boolean;
  checks: ConnectionCheck[];
}

/** Webhook erişilebilirlik probe'u için kısa timeout — teşhis akışını bekletmemek için. */
const WEBHOOK_PROBE_TIMEOUT_MS = 4000;

/** API anahtarı hash'i — sabit sha256 (DB'de düz anahtar durmaz). */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Site satırının admin yanıtlarında GÜVENLE dönebilecek biçimi: TÜM sır-kategorisi kolonlar
 * çıkarılmış — şifreli HMAC secret blobları (mevcut + önceki) ve api_key sha256 hash'leri
 * (mevcut + önceki). Rotasyon/rekey sonrası tutulan `hmacSecretPrevEnc`/`apiKeyHashPrev` de
 * sızmaz (envelope sınırı korunur). Site dönen HER yol (list/update/…) bu mapper'ı kullanır ki
 * sır kolonları tek yerde garanti strip edilsin ve gelecekte yeni bir yol yanlışlıkla sızdırmasın.
 */
export type PublicSite = Omit<
  Site,
  'hmacSecretEnc' | 'hmacSecretPrevEnc' | 'apiKeyHash' | 'apiKeyHashPrev'
>;

export function toPublicSite(row: Site): PublicSite {
  const {
    hmacSecretEnc: _s,
    hmacSecretPrevEnc: _sp,
    apiKeyHash: _a,
    apiKeyHashPrev: _ap,
    ...rest
  } = row;
  return rest;
}

@Injectable()
export class SitesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly crypto: CryptoService,
  ) {}

  /** Yeni site (tenant) oluşturur; anahtar + secret'i bir kez döndürür. */
  async create(input: {
    domain: string;
    type?: SiteType;
    senderEmail?: string;
    webhookUrl?: string;
    /** Günlük satış kotası (§5) — null/verilmezse limitsiz. */
    salesDailyQuota?: number | null;
    /** Sandbox test modu (§14) — true ise mail müşteriye gitmez. */
    sandbox?: boolean;
  }): Promise<CreatedSite> {
    // App-düzeyi domain tekilliği (§14 onboarding sertleştirme): aynı domain için ikinci bir
    // tenant açılması ÇİFT site tenant'a yol açar (tek mağaza iki panel kaydına bölünür, sipariş
    // push'u belirsiz siteye düşer). DB unique index EKLENMEZ — mevcut olası çift veri migration'ı
    // patlatabilir; büyük/küçük harf duyarsız app-kontrolü yeterli. NOT: index yokluğunda eşzamanlı
    // iki create teoride yarışabilir; onboarding düşük-frekanslı manuel bir admin akışı olduğundan
    // (tek operatör, sihirbaz) bu kalan risk kabul edilir.
    const domain = input.domain.trim();
    const [dup] = await this.db
      .select({ id: sites.id })
      .from(sites)
      .where(sql`lower(${sites.domain}) = lower(${domain})`)
      .limit(1);
    if (dup) throw new ConflictException(`Bu domain zaten kayıtlı: ${domain}`);

    const apiKey = `jl_${randomBytes(24).toString('hex')}`;
    const hmacSecret = randomBytes(32).toString('hex');
    // id'yi uygulamada üretiyoruz ki secret'ı bu siteye AAD ile bağlayabilelim (§8).
    const id = randomUUID();

    const [row] = await this.db
      .insert(sites)
      .values({
        id,
        domain,
        type: input.type ?? 'woocommerce',
        apiKeyHash: hashApiKey(apiKey),
        hmacSecretEnc: this.crypto.encrypt(hmacSecret, CryptoService.siteSecretAad(id)),
        senderEmail: input.senderEmail ?? null,
        webhookUrl: input.webhookUrl ?? null,
        salesDailyQuota: input.salesDailyQuota ?? null,
        sandbox: input.sandbox ?? false,
        status: 'active',
      })
      .returning();

    await this.writeAudit('create', row!.id, {
      salesDailyQuota: row!.salesDailyQuota,
      sandbox: row!.sandbox,
    });

    return { id: row!.id, domain: row!.domain, apiKey, hmacSecret };
  }

  /**
   * Operasyon ayarlarını günceller (§5/§14): günlük satış kotası + sandbox.
   * Kritik aksiyon → audit'e düşer (§9). Yalnız verilen alanlar değişir.
   */
  async update(
    id: string,
    input: {
      salesDailyQuota?: number | null;
      dynamicQuotaEnabled?: boolean;
      reviewMultiplier?: number;
      sandbox?: boolean;
      senderEmail?: string | null;
      webhookUrl?: string | null;
      status?: 'active' | 'suspended';
    },
  ): Promise<PublicSite> {
    await this.getById(id); // yoksa 404

    const patch: Partial<typeof sites.$inferInsert> = { updatedAt: new Date() };
    if (input.salesDailyQuota !== undefined) patch.salesDailyQuota = input.salesDailyQuota;
    // Dinamik kota (§8) — açık/kapalı + eşik çarpanı.
    if (input.dynamicQuotaEnabled !== undefined) patch.dynamicQuotaEnabled = input.dynamicQuotaEnabled;
    if (input.reviewMultiplier !== undefined) patch.reviewMultiplier = input.reviewMultiplier;
    if (input.sandbox !== undefined) patch.sandbox = input.sandbox;
    if (input.senderEmail !== undefined) patch.senderEmail = input.senderEmail;
    // Geri kanal webhook hedefi (§2) — null = temizle (webhook sessizce atlanır).
    if (input.webhookUrl !== undefined) patch.webhookUrl = input.webhookUrl;
    if (input.status !== undefined) patch.status = input.status;

    const [row] = await this.db.update(sites).set(patch).where(eq(sites.id, id)).returning();

    await this.writeAudit('update', id, {
      salesDailyQuota: row!.salesDailyQuota,
      sandbox: row!.sandbox,
      senderEmail: row!.senderEmail,
      webhookUrl: row!.webhookUrl,
      status: row!.status,
    });

    // Tüm sır-kategorisi kolonlar tek mapper'da strip edilir (hmacSecretPrevEnc dâhil).
    return toPublicSite(row!);
  }

  /**
   * Site operasyon değişikliğini audit_log'a yazar (§9). En iyi çaba: audit yazımı
   * başarısız olsa bile ana akış (site create/update) BOZULMAZ.
   * NOT: 'site_update' audit_action enum değeri orkestratörce eklenecek (enums + migration);
   * eklenene dek yazım sessizce yutulur (aşağıdaki try/catch).
   */
  private async writeAudit(
    op: 'create' | 'update',
    siteId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.insert(auditLog).values({
        action: 'site_update' as unknown as (typeof auditLog.$inferInsert)['action'],
        actor: 'panel:admin',
        targetType: 'site',
        targetId: siteId,
        meta: { op, ...meta },
      });
    } catch {
      // Audit best-effort — enum değeri henüz yoksa ana akışı bozma (orkestratör tamamlar).
    }
  }

  async list(): Promise<PublicSite[]> {
    const rows = await this.db.select().from(sites);
    return rows.map(toPublicSite);
  }

  /**
   * HMAC guard için: api anahtarı hash'inden aktif siteyi + kabul edilecek secret'ları
   * getirir. Rotasyon penceresi (24s) içindeyse eski secret de listeye eklenir → guard
   * herhangi biriyle eşleşen imzayı kabul eder (kesintisiz anahtar geçişi, §4).
   */
  async findForAuth(apiKey: string): Promise<{ site: Site; hmacSecrets: string[] } | null> {
    // Sabit-zamanlı: karşılaştırılan sha256 HASH'i (sır değil); eşitlik Postgres tarafında
    // parametreli `=` ile yapılır → JS'te erken-çıkışlı string kıyası YOK.
    const hash = hashApiKey(apiKey);
    // api_key rotasyon zarafet penceresi (§4/§14): rekey api_key'i anında değiştirir; ESKİ api_key
    // ile gelen istek normalde bu lookup'ta en başta 401 alır (hmac grace'i bile devreye giremez).
    // Bu yüzden api_key_hash_prev == hash(apiKey) VE rekey HMAC_KEY_ROTATION_GRACE_SEC (24s) içindeyse
    // siteyi yine döneriz — hmac secret grace'inin birebir aynası. Pencere dolunca eski hash reddedilir.
    const graceCutoff = new Date(Date.now() - HMAC_KEY_ROTATION_GRACE_SEC * 1000);
    const [site] = await this.db
      .select()
      .from(sites)
      .where(
        or(
          eq(sites.apiKeyHash, hash),
          and(eq(sites.apiKeyHashPrev, hash), gte(sites.apiKeyRotatedAt, graceCutoff)),
        ),
      )
      .limit(1);

    if (!site || site.status !== 'active') return null;

    const aad = CryptoService.siteSecretAad(site.id);
    const secrets = [this.crypto.decrypt(site.hmacSecretEnc, aad)];

    // Rotasyon zarafet penceresi içindeyse eski secret'ı da kabul et.
    if (
      site.hmacSecretPrevEnc &&
      site.hmacSecretRotatedAt &&
      Date.now() - site.hmacSecretRotatedAt.getTime() <= HMAC_KEY_ROTATION_GRACE_SEC * 1000
    ) {
      secrets.push(this.crypto.decrypt(site.hmacSecretPrevEnc, aad));
    }

    return { site, hmacSecrets: secrets };
  }

  /**
   * Site HMAC secret'ını döndürür (§4). Mevcut secret eskiye taşınır, yeni secret üretilir;
   * 24s boyunca ikisi de geçerli (findForAuth). Yeni secret YALNIZ burada bir kez döner.
   */
  async rotateSecret(siteId: string): Promise<{ hmacSecret: string }> {
    const site = await this.getById(siteId);
    const newSecret = randomBytes(32).toString('hex');
    const aad = CryptoService.siteSecretAad(site.id);

    await this.db
      .update(sites)
      .set({
        // Eski blob AAD'si aynı site id'sine bağlı → prev olarak taşınabilir, çözülebilir kalır.
        hmacSecretPrevEnc: site.hmacSecretEnc,
        hmacSecretEnc: this.crypto.encrypt(newSecret, aad),
        hmacSecretRotatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sites.id, site.id));

    return { hmacSecret: newSecret };
  }

  /**
   * Site kimlik bilgilerini (api_key + hmac_secret) BİRLİKTE yeniler (§14 onboarding).
   * Onboarding "tek-seferlik bağlan kodu" akışının çekirdeği: taze creds tek atışta
   * üretilir; api_key hash'i değişir → ESKİ api_key anında geçersizleşir, hmac_secret
   * rotasyona uğrar (mevcut → prev) → 24s zarafet penceresinde eski secret de kabul
   * edilir (findForAuth) ve WP eklentisi kesintisiz yeni değerlere geçer. Yeni api_key
   * + hmac_secret YALNIZ burada bir kez döner; DB'de düz metin saklanmaz (hash + envelope).
   */
  async rekey(
    siteId: string,
    executor: Database = this.db,
  ): Promise<{ apiKey: string; hmacSecret: string }> {
    const site = await this.getById(siteId);
    const newApiKey = `jl_${randomBytes(24).toString('hex')}`;
    const newHmacSecret = randomBytes(32).toString('hex');
    const aad = CryptoService.siteSecretAad(site.id);

    // Yazım verilen executor üzerinden yapılır: onboarding "bağlan kodu" akışı rekey'i
    // token INSERT'iyle AYNI transaction'da çağırır → kod yazılamazsa rekey de geri alınır
    // (yeni creds üretilip kimseye teslim edilmeyen "yetim/lockout" siteyi önler). Executor
    // verilmezse this.db ile eskisi gibi tek-yazım (geriye dönük uyumlu).
    await executor
      .update(sites)
      .set({
        apiKeyHash: hashApiKey(newApiKey),
        // Eski api_key hash'i prev'e taşınır → findForAuth grace penceresinde (24s) eski api_key
        // ile gelen istek de siteyi bulabilir (hmac grace deseninin birebir aynası, §4/§14).
        apiKeyHashPrev: site.apiKeyHash,
        apiKeyRotatedAt: new Date(),
        // Eski blob'un AAD'si aynı site id'sine bağlı → prev olarak taşınır, çözülebilir kalır.
        hmacSecretPrevEnc: site.hmacSecretEnc,
        hmacSecretEnc: this.crypto.encrypt(newHmacSecret, aad),
        hmacSecretRotatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sites.id, site.id));

    return { apiKey: newApiKey, hmacSecret: newHmacSecret };
  }

  /** Rotasyon için: siteyi + çözülmüş GÜNCEL secret'ı getirir (giden webhook imzası, §2). */
  async getCurrentSecret(siteId: string): Promise<string> {
    const site = await this.getById(siteId);
    return this.crypto.decrypt(site.hmacSecretEnc, CryptoService.siteSecretAad(site.id));
  }

  async getById(id: string): Promise<Site> {
    const [site] = await this.db.select().from(sites).where(eq(sites.id, id)).limit(1);
    if (!site) throw new NotFoundException('Site bulunamadı');
    return site;
  }

  /**
   * Site 360 detayı (§8/§14): yapılandırma + kota kullanımı + son siparişler.
   * SIR (hmac_secret/api_key) yanıta HİÇ konmaz — yalnız güvenli alanlar döner.
   * Sayımlar salt-okunur agregasyon; todayOrderCount SalesQuotaGuard ile aynı
   * pencere (date_trunc('day', now())) → kota kullanımı birebir tutarlı.
   */
  async detail(id: string): Promise<SiteDetail> {
    const site = await this.getById(id); // yoksa 404

    const [mappingRow, orderRow, todayRow, recentOrders] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(siteProductMappings)
        .where(and(eq(siteProductMappings.siteId, id), eq(siteProductMappings.active, true))),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .where(eq(orders.siteId, id)),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .where(and(eq(orders.siteId, id), gte(orders.createdAt, sql`date_trunc('day', now())`))),
      this.db
        .select({
          id: orders.id,
          remoteOrderId: orders.remoteOrderId,
          status: orders.status,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(eq(orders.siteId, id))
        .orderBy(sql`${orders.createdAt} DESC`)
        .limit(10),
    ]);

    return {
      site: {
        id: site.id,
        domain: site.domain,
        type: site.type,
        status: site.status,
        senderEmail: site.senderEmail,
        webhookUrl: site.webhookUrl,
        salesDailyQuota: site.salesDailyQuota,
        dynamicQuotaEnabled: site.dynamicQuotaEnabled,
        reviewMultiplier: site.reviewMultiplier,
        sandbox: site.sandbox,
        createdAt: site.createdAt.toISOString(),
      },
      mappingCount: mappingRow[0]?.count ?? 0,
      orderCount: orderRow[0]?.count ?? 0,
      todayOrderCount: todayRow[0]?.count ?? 0,
      recentOrders: recentOrders.map((o) => ({
        id: o.id,
        remoteOrderId: o.remoteOrderId,
        status: o.status,
        createdAt: o.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Bağlantı sağlık testi (onboarding): panelden açılan bir sitenin gerçekten
   * çalışır durumda olduğunu doğrular. Yapısal teşhis döner (SIR İÇERMEZ):
   *   - Site kaydı var mı (getById 404 atarsa uç zaten 404 döner)
   *   - Site durumu 'active' mi (suspended → findForAuth HMAC auth reddeder, §8)
   *   - HMAC secret çözülebiliyor + beklenen uzunlukta mı (secret'ın kendisi DÖNMEZ)
   *   - (varsa) webhookUrl erişilebilir mi — kısa timeout ile probe, hata YUTULUR
   * Genel `ok` = tüm check'ler geçti. Teşhisin kendisi hiç patlamaz (ağ hatası yutulur).
   */
  async testConnection(id: string): Promise<ConnectionTestResult> {
    const site = await this.getById(id); // yoksa 404
    const checks: ConnectionCheck[] = [];

    // 1) Site kaydı — getById geçtiyse kayıt mevcut.
    checks.push({ name: 'Site kaydı', ok: true, detail: site.domain });

    // 2) Site durumu — 'suspended' ise HMAC auth reddedilir (findForAuth active şartı).
    const active = site.status === 'active';
    checks.push({
      name: 'Site durumu',
      ok: active,
      detail: active ? 'aktif' : 'askıya alınmış — sipariş push reddedilir',
    });

    // 3) HMAC secret — AAD ile çözülebiliyor mu + beklenen uzunlukta mı. SECRET DÖNMEZ.
    try {
      const secret = this.crypto.decrypt(site.hmacSecretEnc, CryptoService.siteSecretAad(site.id));
      const valid = secret.length >= 32;
      checks.push({
        name: 'HMAC secret',
        ok: valid,
        detail: valid ? 'geçerli (şifreli saklı)' : 'beklenmeyen biçim',
      });
    } catch {
      checks.push({
        name: 'HMAC secret',
        ok: false,
        detail: 'çözülemedi — master key uyumsuz olabilir',
      });
    }

    // 4) Geri kanal webhook — yapılandırılmışsa erişilebilirlik probe'u; değilse devre dışı (sorun değil).
    if (site.webhookUrl) {
      checks.push(await this.probeWebhook(site.webhookUrl));
    } else {
      checks.push({
        name: 'Geri kanal webhook',
        ok: true,
        detail: 'yapılandırılmamış (webhook devre dışı)',
      });
    }

    return { ok: checks.every((c) => c.ok), checks };
  }

  /**
   * Webhook hedefine kısa timeout ile ulaşılabilirlik probe'u (HEAD). Herhangi bir HTTP
   * yanıtı (401/404/405 dâhil) hedefin ayakta olduğunu gösterir; yalnız ağ/DNS/timeout
   * hatası erişilemez sayılır. Hata YUTULUR — teşhis akışı asla patlamaz. Bu URL sistemin
   * zaten POST ettiği (§2) admin-yapılandırmalı hedeftir → yeni SSRF yüzeyi açmaz.
   */
  private async probeWebhook(url: string): Promise<ConnectionCheck> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return { name: 'Geri kanal webhook', ok: false, detail: 'geçersiz URL' };
    }
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(WEBHOOK_PROBE_TIMEOUT_MS),
      });
      return {
        name: 'Geri kanal webhook',
        ok: true,
        detail: `${host} erişilebilir (HTTP ${res.status})`,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { name: 'Geri kanal webhook', ok: false, detail: `${host} erişilemedi: ${reason}` };
    }
  }
}
