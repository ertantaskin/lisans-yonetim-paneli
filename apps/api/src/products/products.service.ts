import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import {
  products,
  siteProductMappings,
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

    const [stock, batches, purchaseOrders, velocity, adjustments] = await Promise.all([
      this.detailStock(id),
      this.detailBatches(id),
      this.detailPurchaseOrders(id),
      this.detailVelocity(id),
      this.detailAdjustments(id),
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
    };
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
   */
  private async detailVelocity(id: string): Promise<{ sold7d: number; sold30d: number }> {
    const list = await rawRows<{ sold7d: number; sold30d: number }>(this.db, sql`
      SELECT
        coalesce(sum(a.units) FILTER (WHERE a.created_at >= now() - interval '7 days'), 0)::int AS sold7d,
        coalesce(sum(a.units) FILTER (WHERE a.created_at >= now() - interval '30 days'), 0)::int AS sold30d
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
    remoteVariationId?: string;
    bundleQty?: number;
  }) {
    const [row] = await this.db
      .insert(siteProductMappings)
      .values({
        siteId: input.siteId,
        productId: input.productId,
        remoteProductId: input.remoteProductId,
        remoteVariationId: input.remoteVariationId ?? null,
        bundleQty: input.bundleQty ?? 1,
      })
      .returning();
    return row!;
  }

  /**
   * Eşleme listesi (§3) — remote ürün → panel ürünü, site domain + ürün adıyla
   * zenginleştirilmiş. siteId verilirse yalnız o site; yoksa tümü. En yeni önce.
   */
  async listMappings(siteId?: string): Promise<
    Array<{
      id: string;
      siteId: string;
      siteDomain: string;
      productId: string;
      productName: string;
      remoteProductId: string;
      remoteVariationId: string | null;
      bundleQty: number;
      active: boolean;
      createdAt: string;
    }>
  > {
    const rows = await this.db
      .select({
        id: siteProductMappings.id,
        siteId: siteProductMappings.siteId,
        siteDomain: sites.domain,
        productId: siteProductMappings.productId,
        productName: products.name,
        remoteProductId: siteProductMappings.remoteProductId,
        remoteVariationId: siteProductMappings.remoteVariationId,
        bundleQty: siteProductMappings.bundleQty,
        active: siteProductMappings.active,
        createdAt: siteProductMappings.createdAt,
      })
      .from(siteProductMappings)
      .innerJoin(sites, eq(sites.id, siteProductMappings.siteId))
      .innerJoin(products, eq(products.id, siteProductMappings.productId))
      .where(siteId ? eq(siteProductMappings.siteId, siteId) : undefined)
      .orderBy(desc(siteProductMappings.createdAt));

    return rows.map((r) => ({
      ...r,
      bundleQty: Number(r.bundleQty),
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    }));
  }

  /** Eşlemeyi pasifleştir/etkinleştir (§3). Yoksa 404. */
  async updateMapping(id: string, active: boolean) {
    const [row] = await this.db
      .update(siteProductMappings)
      .set({ active })
      .where(eq(siteProductMappings.id, id))
      .returning();
    if (!row) throw new NotFoundException('Eşleme bulunamadı');
    return row;
  }
}
