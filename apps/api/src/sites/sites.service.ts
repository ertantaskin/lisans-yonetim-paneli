import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { HMAC_KEY_ROTATION_GRACE_SEC, type SiteType } from '@jetlisans/shared';
import { DB, type Database } from '../db/db.module';
import { CryptoService } from '../crypto/crypto.service';
import { auditLog, sites, type Site } from '../db/schema';

export interface CreatedSite {
  id: string;
  domain: string;
  /** Yalnız oluşturmada bir kez döner; sonra saklanmaz (hash tutulur). */
  apiKey: string;
  /** Yalnız oluşturmada bir kez döner (şifreli saklanır). */
  hmacSecret: string;
}

/** API anahtarı hash'i — sabit sha256 (DB'de düz anahtar durmaz). */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
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
    const apiKey = `jl_${randomBytes(24).toString('hex')}`;
    const hmacSecret = randomBytes(32).toString('hex');
    // id'yi uygulamada üretiyoruz ki secret'ı bu siteye AAD ile bağlayabilelim (§8).
    const id = randomUUID();

    const [row] = await this.db
      .insert(sites)
      .values({
        id,
        domain: input.domain,
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
    input: { salesDailyQuota?: number | null; sandbox?: boolean },
  ): Promise<Omit<Site, 'hmacSecretEnc' | 'apiKeyHash'>> {
    await this.getById(id); // yoksa 404

    const patch: Partial<typeof sites.$inferInsert> = { updatedAt: new Date() };
    if (input.salesDailyQuota !== undefined) patch.salesDailyQuota = input.salesDailyQuota;
    if (input.sandbox !== undefined) patch.sandbox = input.sandbox;

    const [row] = await this.db.update(sites).set(patch).where(eq(sites.id, id)).returning();

    await this.writeAudit('update', id, {
      salesDailyQuota: row!.salesDailyQuota,
      sandbox: row!.sandbox,
    });

    const { hmacSecretEnc: _s, apiKeyHash: _a, ...rest } = row!;
    return rest;
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

  async list(): Promise<Array<Omit<Site, 'hmacSecretEnc' | 'apiKeyHash'>>> {
    const rows = await this.db.select().from(sites);
    return rows.map(({ hmacSecretEnc: _s, apiKeyHash: _a, ...rest }) => rest);
  }

  /**
   * HMAC guard için: api anahtarı hash'inden aktif siteyi + kabul edilecek secret'ları
   * getirir. Rotasyon penceresi (24s) içindeyse eski secret de listeye eklenir → guard
   * herhangi biriyle eşleşen imzayı kabul eder (kesintisiz anahtar geçişi, §4).
   */
  async findForAuth(apiKey: string): Promise<{ site: Site; hmacSecrets: string[] } | null> {
    const [site] = await this.db
      .select()
      .from(sites)
      .where(eq(sites.apiKeyHash, hashApiKey(apiKey)))
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
}
