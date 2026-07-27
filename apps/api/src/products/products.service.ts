import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import {
  products,
  siteProductMappings,
  siteRemoteProducts,
  sites,
  licenseItems,
  type NewProduct,
  type Product,
} from '../db/schema';

/** Ürün detay sayfası (§13) — salt-okunur agregasyon, mevcut tablolardan türetilir. */
export interface ProductDetail {
  product: Product;
  /** license_items status kırılımı. available = kalan kapasite (Σ max_uses−use_count), diğerleri satır sayısı. */
  stock: {
    available: number;
    assigned: number;
    revoked: number;
    expired: number;
    voided: number;
  };
  batches: Array<{ id: string; label: string; status: string; qtyReceived: number }>;
  purchaseOrders: Array<{
    id: string;
    status: string;
    qtyOrdered: number;
    qtyReceived: number;
    eta: string | null;
  }>;
  velocity: {
    sold7d: number;
    sold30d: number;
    /** sold30d / 30. */
    dailyRate: number;
    /** available / dailyRate (yuvarlanmış); dailyRate=0 ise null. */
    daysRemaining: number | null;
  };
  adjustments: Array<{
    id: string;
    action: string;
    qty: number;
    reason: string;
    createdAt: string;
  }>;
  /** Bu ürünün site eşlemeleri (§3) — ürün-merkezli yönetim: eşleme artık ürün detayında. */
  mappings: Array<{
    id: string;
    siteId: string;
    siteDomain: string;
    productId: string;
    productName: string;
    remoteProductId: string;
    remoteVariationId: string | null;
    /** Katalogdan öğrenilen mağaza ürün adı (varsa) — ham ID yerine operatör dostu; yoksa null. */
    remoteName: string | null;
    bundleQty: number;
    active: boolean;
    createdAt: string;
  }>;
}

@Injectable()
export class ProductsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async create(input: NewProduct): Promise<Product> {
    const [row] = await this.db.insert(products).values(input).returning();
    return row!;
  }

  /**
   * Kısmi ürün güncellemesi (§11). Yalnız verilen alanlar değişir; updatedAt her
   * güncellemede now() olur. Boş patch (hiç alan yok) reddedilir — yanlışlıkla
   * yalnız updatedAt dokunmasını engeller. Ürün yoksa 404.
   * Null semantiği: patch'te ANAHTAR YOK → kolon değişmez; anahtar VAR ama değer null
   * → kolon TEMİZLENİR (Drizzle .set() null'ı SET col = null'a çevirir) → opsiyonel
   * alan (validityDays/warrantyDays/lowStockThreshold/keyFormat/releaseAt) boşaltılabilir.
   */
  async update(id: string, patch: Partial<NewProduct>): Promise<Product> {
    if (Object.keys(patch).length === 0) {
      throw new NotFoundException('Güncellenecek alan yok');
    }
    const [row] = await this.db
      .update(products)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(products.id, id))
      .returning();
    if (!row) throw new NotFoundException('Ürün bulunamadı');
    return row;
  }

  async list(): Promise<Array<Product & { availableStock: number }>> {
    // Ürün başına anlık 'available' stok sayısı — tek GROUP BY agregasyonu.
    // status='available' filtresi JOIN ON'a alındı: yalnız uygun satırlar okunur,
    // partial index (license_items_available_idx: product_id,created_at WHERE
    // status='available') kullanılır; assigned/revoked/expired satırlar taranmaz.
    // LEFT JOIN korunur → stoksuz ürün de NULL→coalesce 0 ile listede kalır.
    const rows = await this.db
      .select({
        product: products,
        // Kalan kapasite: single'da satır sayısı, multi'de (max_uses - use_count) toplamı.
        availableStock: sql<number>`coalesce(sum(${licenseItems.maxUses} - ${licenseItems.useCount}), 0)`,
      })
      .from(products)
      .leftJoin(
        licenseItems,
        and(eq(licenseItems.productId, products.id), eq(licenseItems.status, 'available')),
      )
      .groupBy(products.id);

    return rows.map((r) => ({ ...r.product, availableStock: Number(r.availableStock) }));
  }

  async getById(id: string): Promise<Product> {
    const [row] = await this.db.select().from(products).where(eq(products.id, id)).limit(1);
    if (!row) throw new NotFoundException('Ürün bulunamadı');
    return row;
  }

  /**
   * Ürün detay panosu (§13) — salt-okunur agregasyon. Ürünü getById ile çözer
   * (yoksa 404), ardından stok kırılımı / parti / satın-alma emri / satış hızı /
   * stok düzeltmelerini mevcut tablolardan (license_items, batches, purchase_orders,
   * assignments, stock_adjustments) toplar. Hiçbir yazma/yan etki yok.
   */
  async getDetail(id: string): Promise<ProductDetail> {
    const product = await this.getById(id);

    const [stock, batches, purchaseOrders, velocity, adjustments, mappings] = await Promise.all([
      this.detailStock(id),
      this.detailBatches(id),
      this.detailPurchaseOrders(id),
      this.detailVelocity(id),
      this.detailAdjustments(id),
      this.detailMappings(id),
    ]);

    // Tükenme tahmini: kalan available kapasitesini günlük satış hızına böl.
    const dailyRate = velocity.sold30d / 30;
    const daysRemaining =
      dailyRate > 0 ? Math.round(stock.available / dailyRate) : null;

    return {
      product,
      stock,
      batches,
      purchaseOrders,
      velocity: {
        sold7d: velocity.sold7d,
        sold30d: velocity.sold30d,
        // dailyRate sunum için 2 ondalığa; daysRemaining ham orandan hesaplandı.
        dailyRate: Math.round(dailyRate * 100) / 100,
        daysRemaining,
      },
      adjustments,
      mappings,
    };
  }

  /**
   * Bu ürüne bağlı site eşlemeleri (§3) — site domain + ürün adıyla zenginleştirilmiş,
   * tek ürüne daraltılmış (ürün-merkezli yönetim: eşleme oluşturma/aç-kapa ürün detayında).
   */
  private async detailMappings(id: string): Promise<ProductDetail['mappings']> {
    const rows = await this.db
      .select({
        id: siteProductMappings.id,
        siteId: siteProductMappings.siteId,
        siteDomain: sites.domain,
        productId: siteProductMappings.productId,
        productName: products.name,
        remoteProductId: siteProductMappings.remoteProductId,
        remoteVariationId: siteProductMappings.remoteVariationId,
        remoteName: siteRemoteProducts.name,
        bundleQty: siteProductMappings.bundleQty,
        active: siteProductMappings.active,
        createdAt: siteProductMappings.createdAt,
      })
      .from(siteProductMappings)
      .innerJoin(sites, eq(sites.id, siteProductMappings.siteId))
      .innerJoin(products, eq(products.id, siteProductMappings.productId))
      // Katalog snapshot'ından mağaza ürün adını öğren (varsa) — ham ID yerine ad göster.
      // (site, remote_product_id, varyasyon-eşit-VEYA-ikisi-de-null) ile tek satır eşleşir (unique index).
      .leftJoin(
        siteRemoteProducts,
        and(
          eq(siteRemoteProducts.siteId, siteProductMappings.siteId),
          eq(siteRemoteProducts.remoteProductId, siteProductMappings.remoteProductId),
          or(
            eq(siteRemoteProducts.remoteVariationId, siteProductMappings.remoteVariationId),
            and(
              isNull(siteRemoteProducts.remoteVariationId),
              isNull(siteProductMappings.remoteVariationId),
            ),
          ),
        ),
      )
      .where(eq(siteProductMappings.productId, id))
      .orderBy(desc(siteProductMappings.createdAt));
    return rows.map((r) => ({
      ...r,
      bundleQty: Number(r.bundleQty),
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    }));
  }

  /**
   * license_items status kırılımı. available = kalan kapasite (Σ max_uses−use_count,
   * products.list/reports ile AYNI semantik); assigned/revoked/expired/voided = satır sayısı.
   */
  private async detailStock(id: string): Promise<ProductDetail['stock']> {
    const list = await rawRows<{ status: string; cnt: number; remaining: number }>(this.db, sql`
      SELECT
        status,
        count(*)::int AS cnt,
        coalesce(sum(max_uses - use_count), 0)::int AS remaining
      FROM license_items
      WHERE product_id = ${id}
      GROUP BY status;
    `);
    const by: Record<string, { cnt: number; remaining: number }> = {};
    for (const r of list) by[r.status] = { cnt: Number(r.cnt), remaining: Number(r.remaining) };
    return {
      available: by['available']?.remaining ?? 0,
      assigned: by['assigned']?.cnt ?? 0,
      revoked: by['revoked']?.cnt ?? 0,
      expired: by['expired']?.cnt ?? 0,
      voided: by['voided']?.cnt ?? 0,
    };
  }

  /** Bu ürüne bağlı teslim partileri (§12), en yeni önce. */
  private async detailBatches(id: string): Promise<ProductDetail['batches']> {
    const list = await rawRows<{
      id: string;
      label: string;
      status: string;
      qty_received: number;
    }>(this.db, sql`
      SELECT id, label, status, qty_received
      FROM batches
      WHERE product_id = ${id}
      ORDER BY received_at DESC, created_at DESC;
    `);
    return list.map((r) => ({
      id: r.id,
      label: r.label,
      status: r.status,
      qtyReceived: Number(r.qty_received),
    }));
  }

  /** Bu ürüne verilmiş satın alma emirleri (§12), en yeni önce. */
  private async detailPurchaseOrders(id: string): Promise<ProductDetail['purchaseOrders']> {
    const list = await rawRows<{
      id: string;
      status: string;
      qty_ordered: number;
      qty_received: number;
      eta: string | null;
    }>(this.db, sql`
      SELECT id, status, qty_ordered, qty_received, eta
      FROM purchase_orders
      WHERE product_id = ${id}
      ORDER BY created_at DESC;
    `);
    return list.map((r) => ({
      id: r.id,
      status: r.status,
      qtyOrdered: Number(r.qty_ordered),
      qtyReceived: Number(r.qty_received),
      eta: r.eta,
    }));
  }

  /**
   * Satış hızı: bu ürünün atamalarında (assignments→order_lines) 7/30 gün penceresinde
   * tüketilen units toplamı. reports.velocity ile AYNI mantık, tek ürüne daraltılmış.
   * Yalnız AYAKTA atamalar (active/suspended/expired) — iade/değişimde geri alınan eski
   * atama satış SAYILMAZ (reports.velocity ile tutarlı).
   */
  private async detailVelocity(id: string): Promise<{ sold7d: number; sold30d: number }> {
    const list = await rawRows<{ sold7d: number; sold30d: number }>(this.db, sql`
      SELECT
        coalesce(sum(a.units) FILTER (WHERE a.created_at >= now() - interval '7 days' AND a.status IN ('active','suspended','expired')), 0)::int AS sold7d,
        coalesce(sum(a.units) FILTER (WHERE a.created_at >= now() - interval '30 days' AND a.status IN ('active','suspended','expired')), 0)::int AS sold30d
      FROM assignments a
      JOIN order_lines ol ON ol.id = a.line_id
      WHERE ol.product_id = ${id};
    `);
    return { sold7d: Number(list[0]?.sold7d ?? 0), sold30d: Number(list[0]?.sold30d ?? 0) };
  }

  /** Sebepli stok düzeltme izi (§12), en yeni önce (son 50). */
  private async detailAdjustments(id: string): Promise<ProductDetail['adjustments']> {
    const list = await rawRows<{
      id: string;
      action: string;
      qty: number;
      reason: string;
      created_at: string;
    }>(this.db, sql`
      SELECT id, action, qty, reason, created_at
      FROM stock_adjustments
      WHERE product_id = ${id}
      ORDER BY created_at DESC
      LIMIT 50;
    `);
    return list.map((r) => ({
      id: r.id,
      action: r.action,
      qty: Number(r.qty),
      reason: r.reason,
      createdAt: r.created_at,
    }));
  }

  /** Site-facing sipariş akışı için: remote ürün → panel ürünü çöz (§2 mapping_not_found). */
  async resolveMapping(
    siteId: string,
    remoteProductId: string,
    remoteVariationId?: string | null,
  ): Promise<{ productId: string; bundleQty: number } | null> {
    // '0'/boş varyasyon = varyasyon yok (Woo bazen '0' gönderir).
    const variation = remoteVariationId && remoteVariationId !== '0' ? remoteVariationId : null;

    // 1) Varyasyon-özel eşleme (varsa) — en spesifik.
    if (variation) {
      const [row] = await this.db
        .select()
        .from(siteProductMappings)
        .where(
          and(
            eq(siteProductMappings.siteId, siteId),
            eq(siteProductMappings.remoteProductId, remoteProductId),
            eq(siteProductMappings.remoteVariationId, variation),
            eq(siteProductMappings.active, true),
          ),
        )
        .orderBy(asc(siteProductMappings.createdAt))
        .limit(1);
      if (row) return { productId: row.productId, bundleQty: row.bundleQty };
    }

    // 2) Ürün-seviyesi (varyasyon null) eşleme — fallback, deterministik (en eski).
    const [row] = await this.db
      .select()
      .from(siteProductMappings)
      .where(
        and(
          eq(siteProductMappings.siteId, siteId),
          eq(siteProductMappings.remoteProductId, remoteProductId),
          isNull(siteProductMappings.remoteVariationId),
          eq(siteProductMappings.active, true),
        ),
      )
      .orderBy(asc(siteProductMappings.createdAt))
      .limit(1);

    return row ? { productId: row.productId, bundleQty: row.bundleQty } : null;
  }

  async createMapping(input: {
    siteId: string;
    productId: string;
    remoteProductId: string;
    remoteVariationId?: string | null;
    bundleQty?: number;
  }) {
    // Biçimi geçerli ama VAR OLMAYAN site/ürün id'si → ham Postgres FK ihlali (23503) →
    // opak 500. stock.import/sites.update deseni gibi önce varlığı çöz, yoksa anlamlı 404.
    await this.getById(input.productId); // ürün yoksa 404
    const [site] = await this.db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.id, input.siteId))
      .limit(1);
    if (!site) throw new NotFoundException('Site bulunamadı');

    // '0'/boş varyasyon = varyasyon yok (resolveMapping ile AYNI normalizasyon) → depoda null.
    const variation =
      input.remoteVariationId && input.remoteVariationId !== '0' ? input.remoteVariationId : null;

    // KRİTİK: unique index (site, remote_product_id, remote_variation_id) Postgres'te NULL'ları
    // AYRI sayar → aynı (site, ürün, varyasyonsuz) için İKİ eşleme eklenebilir (sessiz mükerrer,
    // resolveMapping "en eski"i seçer). advisory-lock + app-düzeyi ön-kontrol ile kapatılır
    // (D3 site-scoped upsert deseni; artık panel formu da güvenli). Kilit anahtarı normalize varyasyonu içerir.
    // KRİTİK: advisory-lock anahtarı upsertSiteMapping (WP "Panel Eşlemesi" kutusu,
    // /v1/site-mappings) ile BİREBİR AYNI olmalı → iki yazar aynı kilitte serialize olur. Farklı
    // anahtar (ör. 'map:' önekli) kullanılsaydı eşzamanlı panel-formu + WP-kutu, NULL-varyasyonda
    // (unique index NULL'ı ayrı sayar) çift-satır üretebilirdi (denetim MED bulgusu).
    const lockKey = `${input.siteId}:${input.remoteProductId}:${variation ?? ''}`;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const existing = await tx
        .select({ id: siteProductMappings.id })
        .from(siteProductMappings)
        .where(
          and(
            eq(siteProductMappings.siteId, input.siteId),
            eq(siteProductMappings.remoteProductId, input.remoteProductId),
            variation
              ? eq(siteProductMappings.remoteVariationId, variation)
              : isNull(siteProductMappings.remoteVariationId),
          ),
        )
        .limit(1);
      if (existing.length) {
        throw new ConflictException('Bu site + mağaza ürün/varyasyon eşlemesi zaten kayıtlı');
      }
      try {
        const [row] = await tx
          .insert(siteProductMappings)
          .values({
            siteId: input.siteId,
            productId: input.productId,
            remoteProductId: input.remoteProductId,
            remoteVariationId: variation,
            bundleQty: input.bundleQty ?? 1,
          })
          .returning();
        return row!;
      } catch (err) {
        // Varyasyonlu yarışta mappings_site_remote_uniq (23505) → ham 500 yerine anlamlı 409.
        if (String(err).toLowerCase().includes('unique') || String(err).includes('23505')) {
          throw new ConflictException('Bu site + mağaza ürün/varyasyon eşlemesi zaten kayıtlı');
        }
        throw err;
      }
    });
  }

  /**
   * "Eşlenmemiş gelen ürünler" (§3): gerçek siparişlerde gelmiş AMA hâlâ aktif eşlemesi olmayan
   * mağaza ürünleri — (site, mağaza ürün, varyasyon) bazında gruplanır, en son gelen ad + adet +
   * son görülme ile. Operatör buradan ELLE ID yazmadan tek-tıkla eşler (typo riski biter).
   * Yalnız 0022 sonrası siparişlerde remote_product_id dolu; öncekiler görünmez (geriye dönük zararsız).
   */
  async listUnmapped() {
    const rows = await rawRows<{
      site_id: string;
      domain: string;
      remote_product_id: string;
      remote_variation_id: string | null;
      name: string | null;
      line_count: number;
      order_count: number;
      last_seen: string;
    }>(
      this.db,
      sql`
        SELECT o.site_id,
               s.domain,
               ol.remote_product_id,
               NULLIF(NULLIF(ol.remote_variation_id, '0'), '') AS remote_variation_id,
               MAX(ol.remote_name) AS name,
               COUNT(*)::int AS line_count,
               COUNT(DISTINCT o.id)::int AS order_count,
               MAX(o.created_at) AS last_seen
        FROM order_lines ol
        JOIN orders o ON ol.order_id = o.id
        JOIN sites s ON o.site_id = s.id
        WHERE ol.product_id IS NULL
          AND ol.canceled = false
          AND ol.remote_product_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM site_product_mappings m
            WHERE m.site_id = o.site_id
              AND m.remote_product_id = ol.remote_product_id
              AND m.active = true
              AND (
                m.remote_variation_id IS NULL
                OR m.remote_variation_id = NULLIF(NULLIF(ol.remote_variation_id, '0'), '')
              )
          )
        GROUP BY o.site_id, s.domain, ol.remote_product_id,
                 NULLIF(NULLIF(ol.remote_variation_id, '0'), '')
        ORDER BY last_seen DESC
        LIMIT 500
      `,
    );
    return rows.map((r) => ({
      siteId: r.site_id,
      siteDomain: r.domain,
      remoteProductId: r.remote_product_id,
      remoteVariationId: r.remote_variation_id,
      remoteName: r.name,
      lineCount: Number(r.line_count),
      orderCount: Number(r.order_count),
      lastSeen: r.last_seen,
    }));
  }

  /**
   * Eşleme kısmi güncelleme (§3): aktif/pasif toggle VE/VEYA hedef panel ürününü DEĞİŞTİR (remap) +
   * bundle adedi. productId verilirse ürün varlığı doğrulanır (yoksa 404, ham FK 500 yerine). En az
   * bir alan zorunlu. (site, remote, varyasyon) anahtarı değişmediği için remap unique çakışması
   * YARATMAZ — advisory-lock gerekmez. Eşleme HER ZAMAN operatör kontrolünde; otomatik değişim YOK.
   */
  async updateMapping(
    id: string,
    patch: { active?: boolean; productId?: string; bundleQty?: number },
  ) {
    const set: Partial<typeof siteProductMappings.$inferInsert> = {};
    if (patch.active !== undefined) set.active = patch.active;
    if (patch.productId !== undefined) {
      await this.getById(patch.productId); // hedef ürün yoksa 404
      set.productId = patch.productId;
    }
    if (patch.bundleQty !== undefined) set.bundleQty = patch.bundleQty;
    if (Object.keys(set).length === 0) {
      throw new BadRequestException('Güncellenecek alan yok');
    }
    const [row] = await this.db
      .update(siteProductMappings)
      .set(set)
      .where(eq(siteProductMappings.id, id))
      .returning();
    if (!row) throw new NotFoundException('Eşleme bulunamadı');
    return row;
  }

  /**
   * Eşlemeyi TAMAMEN kaldır (§3). Yoksa 404. Sonrasında bu mağaza ürününün siparişleri artık panel
   * ürünü çözemez (unmapped → pending; yanlış teslim YOK). Operatör dilerse yeniden eşler.
   */
  async deleteMapping(id: string) {
    const [row] = await this.db
      .delete(siteProductMappings)
      .where(eq(siteProductMappings.id, id))
      .returning({ id: siteProductMappings.id });
    if (!row) throw new NotFoundException('Eşleme bulunamadı');
    return { id: row.id, deleted: true };
  }

  // ─── Mağaza ürün kataloğu senkronu (§3 — panelde PROAKTİF eşleme) ────────────────────

  /**
   * Katalog senkronu (site-facing HMAC): WP eklentisi sitenin yayınlanmış ürünlerini (ad/sku/tip/
   * varyasyon) gönderir → panel snapshot'ı YENİLER (delete+insert, atomik). Eşlemeler
   * (site_product_mappings) AYRI tablo → katalog yenilense de kopmaz. SIR YOK. Amaç: operatör
   * sipariş beklemeden mağaza ürününü ADIYLA seçip eşlesin (elle ham ID yazmasın).
   */
  async syncCatalog(
    siteId: string,
    items: Array<{
      remoteProductId: string;
      remoteVariationId?: string | null;
      name: string;
      sku?: string | null;
      kind?: string | null;
    }>,
  ): Promise<{ synced: number }> {
    // Boş snapshot'ı NO-OP say (kataloğu SİLME): WP'de toplu düzenlemede tüm ürünler geçici olarak
    // taslağa düşerse ya da object-cache boş dönerse gelen boş dizi mevcut kataloğu YANLIŞLIKLA
    // silmesin. Gerçek "0 ürün" durumu da proaktif eşleme için anlamsız; snapshot korunur, sonraki
    // gerçek senkron düzeltir. (Silme YALNIZ dolu snapshot geldiğinde, replace semantiğiyle olur.)
    if (!items.length) return { synced: 0 };
    // Eşzamanlı aynı-site tam-snapshot'ları serileştir (upsertSiteMapping deseni): manuel "Ürünleri
    // Panele Aktar" ile arka plan otomatik senkron ÇAKIŞABİLİR. Kilit olmadan (a) varyasyonlu
    // katalogda T2 insert 23505 → 500; (b) tüm-basit katalogda unique index NULL'ı AYRI saydığından
    // çift satır kalır (ürün 2× görünür, sayı şişer). Advisory-xact-lock delete+insert'i atomik yapar.
    const lockKey = `catalog:${siteId}`;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      await tx.delete(siteRemoteProducts).where(eq(siteRemoteProducts.siteId, siteId));
      const seen = new Set<string>();
      const rows = items
        .map((it) => {
          const variation =
            it.remoteVariationId && it.remoteVariationId !== '0' ? it.remoteVariationId : null;
          return {
            siteId,
            remoteProductId: it.remoteProductId,
            remoteVariationId: variation,
            name: it.name.slice(0, 500),
            sku: it.sku ? it.sku.slice(0, 120) : null,
            kind: it.kind ? it.kind.slice(0, 40) : null,
          };
        })
        // unique index NULL'ı ayrı sayar → delete+insert içinde mükerrer (product,variation) çift
        // satırı INSERT'i patlatmasın diye app-düzeyi dedup (ilk kazanır).
        .filter((r) => {
          const k = `${r.remoteProductId}::${r.remoteVariationId ?? ''}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      for (let i = 0; i < rows.length; i += 500) {
        await tx.insert(siteRemoteProducts).values(rows.slice(i, i + 500));
      }
      return { synced: rows.length };
    });
  }

  /** Sitelerin katalog özeti (picker için): aktif ürün sayısı + son senkron; katalog yoksa 0. */
  async catalogSummary() {
    const rows = await rawRows<{
      site_id: string;
      domain: string;
      product_count: number;
      last_synced_at: string | null;
    }>(
      this.db,
      sql`
        SELECT s.id AS site_id, s.domain,
               COUNT(rp.id)::int AS product_count,
               MAX(rp.synced_at) AS last_synced_at
        FROM sites s
        LEFT JOIN site_remote_products rp ON rp.site_id = s.id AND rp.active = true
        GROUP BY s.id, s.domain
        ORDER BY s.domain
      `,
    );
    return rows.map((r) => ({
      siteId: r.site_id,
      domain: r.domain,
      productCount: Number(r.product_count),
      lastSyncedAt: r.last_synced_at,
    }));
  }

  /**
   * Bir sitenin senkron kataloğu + her ürünün EŞLEME DURUMU (eşli → panel ürün adı + bundle; yoksa
   * null). Eşli mantığı resolveMapping ile aynı (varyasyon-özel VEYA ürün-seviyesi; en spesifik
   * tercih — DISTINCT ON). Eşlenmemiş ÜSTTE. Panelde proaktif eşleme ekranını besler.
   */
  async listCatalog(siteId: string) {
    const rows = await rawRows<{
      remote_product_id: string;
      remote_variation_id: string | null;
      name: string;
      sku: string | null;
      kind: string | null;
      synced_at: string;
      mapping_id: string | null;
      mapped_product_id: string | null;
      bundle_qty: number | null;
      mapped_product_name: string | null;
    }>(
      this.db,
      sql`
        SELECT * FROM (
          SELECT DISTINCT ON (rp.id)
                 rp.id,
                 rp.remote_product_id, rp.remote_variation_id, rp.name, rp.sku, rp.kind, rp.synced_at,
                 m.id AS mapping_id, m.product_id AS mapped_product_id, m.bundle_qty, p.name AS mapped_product_name
          FROM site_remote_products rp
          LEFT JOIN site_product_mappings m
            ON m.site_id = rp.site_id
           AND m.remote_product_id = rp.remote_product_id
           AND m.active = true
           AND (m.remote_variation_id IS NULL OR m.remote_variation_id = rp.remote_variation_id)
          LEFT JOIN products p ON p.id = m.product_id
          WHERE rp.site_id = ${siteId} AND rp.active = true
          ORDER BY rp.id, (m.remote_variation_id IS NOT NULL) DESC
        ) t
        ORDER BY (t.mapped_product_id IS NOT NULL), t.name
        LIMIT 5000
      `,
    );
    return rows.map((r) => ({
      remoteProductId: r.remote_product_id,
      remoteVariationId: r.remote_variation_id,
      name: r.name,
      sku: r.sku,
      kind: r.kind,
      syncedAt: r.synced_at,
      mapped: r.mapped_product_id !== null,
      mappingId: r.mapping_id,
      mappedProductId: r.mapped_product_id,
      mappedProductName: r.mapped_product_name,
      bundleQty: r.bundle_qty,
    }));
  }

  // ─── §7 WP ürün-eşleme kutusu (site-scoped, HMAC) ────────────────────────────────────
  // WP ürün-düzenleme ekranındaki "Panel Eşlemesi" kutusu için hafif katalog + site-scoped
  // eşleme CRUD. SIR YOK (yalnız ürün adı/sku/tip; fiyat/lisans DÖNMEZ). Tüm yazma/okuma
  // ÇAĞIRAN SİTEYE scope'lu (controller CurrentSite.id geçirir) → başka sitenin eşlemesine dokunulmaz.

  /** Eşleme kutusu ürün seçici: hafif katalog listesi (sır yok). */
  async listForCatalog() {
    return this.db
      .select({
        id: products.id,
        name: products.name,
        sku: products.sku,
        kind: products.kind,
        usageMode: products.usageMode,
      })
      .from(products)
      .orderBy(asc(products.name))
      .limit(500);
  }

  /** Bu sitenin eşlemeleri (ürün adıyla); opsiyonel remoteProductId filtresi (o Woo ürünü). */
  async listSiteMappings(siteId: string, remoteProductId?: string) {
    const where = remoteProductId
      ? and(
          eq(siteProductMappings.siteId, siteId),
          eq(siteProductMappings.remoteProductId, remoteProductId),
        )
      : eq(siteProductMappings.siteId, siteId);
    return this.db
      .select({
        id: siteProductMappings.id,
        remoteProductId: siteProductMappings.remoteProductId,
        remoteVariationId: siteProductMappings.remoteVariationId,
        productId: siteProductMappings.productId,
        productName: products.name,
        productSku: products.sku,
        bundleQty: siteProductMappings.bundleQty,
        active: siteProductMappings.active,
      })
      .from(siteProductMappings)
      .innerJoin(products, eq(siteProductMappings.productId, products.id))
      .where(where)
      .orderBy(asc(siteProductMappings.remoteProductId))
      .limit(500);
  }

  /**
   * Site-scoped eşleme UPSERT (§7 WP kutusu). (site, remoteProductId, varyasyon) varsa GÜNCELLE,
   * yoksa EKLE. NULL-varyasyon güvenli (Postgres unique index NULL'ları ayrı sayar → onConflict
   * fire etmez; bu yüzden elle select-then-write). Ürün yoksa 404 (FK 500 yerine anlamlı).
   */
  async upsertSiteMapping(input: {
    siteId: string;
    productId: string;
    remoteProductId: string;
    remoteVariationId?: string;
    bundleQty?: number;
  }) {
    await this.getById(input.productId); // ürün yoksa 404
    const variation =
      input.remoteVariationId && input.remoteVariationId !== '0' ? input.remoteVariationId : null;

    // Denetim (TOCTOU): select-then-write iki eşzamanlı çağrıda (site, remoteProductId, variation=null)
    // için ÇİFT satır üretebilirdi — Postgres unique index NULL varyasyonu AYRI sayar, onConflict
    // fire etmez. Advisory-xact-lock ile (site+remote+variation başına) serileştir → tek satır garanti.
    const lockKey = `${input.siteId}:${input.remoteProductId}:${variation ?? ''}`;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

      const [existing] = await tx
        .select({ id: siteProductMappings.id })
        .from(siteProductMappings)
        .where(
          and(
            eq(siteProductMappings.siteId, input.siteId),
            eq(siteProductMappings.remoteProductId, input.remoteProductId),
            variation === null
              ? isNull(siteProductMappings.remoteVariationId)
              : eq(siteProductMappings.remoteVariationId, variation),
          ),
        )
        .limit(1);

      if (existing) {
        const [row] = await tx
          .update(siteProductMappings)
          .set({ productId: input.productId, bundleQty: input.bundleQty ?? 1, active: true })
          .where(eq(siteProductMappings.id, existing.id))
          .returning();
        return row!;
      }
      try {
        const [row] = await tx
          .insert(siteProductMappings)
          .values({
            siteId: input.siteId,
            productId: input.productId,
            remoteProductId: input.remoteProductId,
            remoteVariationId: variation,
            bundleQty: input.bundleQty ?? 1,
          })
          .returning();
        return row!;
      } catch (err) {
        // Varyasyonlu yol: mappings_site_remote_uniq ihlali → ham 500 yerine anlamlı 409.
        if (String(err).toLowerCase().includes('unique') || String(err).includes('23505')) {
          throw new ConflictException('Bu site + remote ürün/varyasyon eşlemesi zaten kayıtlı');
        }
        throw err;
      }
    });
  }

  /** Bu sitenin (remoteProductId, varyasyon) eşlemesini sil (§7 "Eşlemeyi kaldır"). */
  async deleteSiteMapping(siteId: string, remoteProductId: string, remoteVariationId?: string) {
    const variation =
      remoteVariationId && remoteVariationId !== '0' ? remoteVariationId : null;
    await this.db
      .delete(siteProductMappings)
      .where(
        and(
          eq(siteProductMappings.siteId, siteId),
          eq(siteProductMappings.remoteProductId, remoteProductId),
          variation === null
            ? isNull(siteProductMappings.remoteVariationId)
            : eq(siteProductMappings.remoteVariationId, variation),
        ),
      );
    return { deleted: true };
  }
}
