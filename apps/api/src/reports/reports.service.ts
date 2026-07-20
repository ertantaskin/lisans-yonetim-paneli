import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';

/** Ürün başına anlık stok satırı (products.service.list mantığı). */
export interface StockByProduct {
  productId: string;
  sku: string;
  name: string;
  available: number;
}

/** Ürün başına satış hızı — 7/30 günlük pencere + tükenme tahmini. */
export interface VelocityRow {
  productId: string;
  sku: string;
  sold7d: number;
  sold30d: number;
  /** Günlük ortalama tüketim (sold30d/30). */
  dailyRate: number;
  /** Kalan stokun tükenme süresi (gün); dailyRate=0 ise null (tahmin edilemez). */
  daysRemaining: number | null;
}

/** Panel genel bakış raporu (§18). Salt-okunur agregasyon — yan etki yok. */
export interface ReportsOverview {
  orders: { total: number; byStatus: Record<string, number> };
  fulfillment: { lines: number; fulfilled: number; partial: number; pending: number };
  stock: { totalAvailable: number; byProduct: StockByProduct[] };
  velocity: VelocityRow[];
  replacements: { total: number; approved: number; rate: number };
}

/**
 * Raporlar servisi (§18) — salt-okunur agregasyon. Hiçbir yazma/yan etki yapmaz,
 * yalnız mevcut tablolardan (orders, order_lines, license_items, assignments,
 * replacement_requests) özet üretir. low_stock eşiği W1'in işi; buraya karışmaz.
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Tüm rapor bloklarını paralel toplayıp tek genel bakış nesnesi döndürür. */
  async overview(): Promise<ReportsOverview> {
    const [orders, fulfillment, stock, velocity, replacements] = await Promise.all([
      this.orders(),
      this.fulfillment(),
      this.stock(),
      this.velocity(),
      this.replacements(),
    ]);
    return { orders, fulfillment, stock, velocity, replacements };
  }

  /** Sipariş sayısı + duruma göre kırılım (orders.status). */
  private async orders(): Promise<ReportsOverview['orders']> {
    const rows = await this.db.execute<{ status: string; c: number }>(sql`
      SELECT status, count(*)::int AS c
      FROM orders
      GROUP BY status;
    `);
    const list = rows as unknown as Array<{ status: string; c: number }>;
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of list) {
      const c = Number(r.c);
      byStatus[r.status] = c;
      total += c;
    }
    return { total, byStatus };
  }

  /** Sipariş satırı teslim durumu kırılımı (order_lines.status). */
  private async fulfillment(): Promise<ReportsOverview['fulfillment']> {
    const rows = await this.db.execute<{ status: string; c: number }>(sql`
      SELECT status, count(*)::int AS c
      FROM order_lines
      GROUP BY status;
    `);
    const list = rows as unknown as Array<{ status: string; c: number }>;
    const by: Record<string, number> = {};
    let lines = 0;
    for (const r of list) {
      const c = Number(r.c);
      by[r.status] = c;
      lines += c;
    }
    return {
      lines,
      fulfilled: by['fulfilled'] ?? 0,
      partial: by['partial'] ?? 0,
      pending: by['pending'] ?? 0,
    };
  }

  /**
   * Ürün başına anlık 'available' stok (products.service.list ile AYNI mantık:
   * status='available' license_item'ların (max_uses - use_count) toplamı). Stoksuz
   * ürün de LEFT JOIN → coalesce 0 ile listede kalır.
   */
  private async stock(): Promise<ReportsOverview['stock']> {
    const rows = await this.db.execute<{
      product_id: string;
      sku: string;
      name: string;
      available: number;
    }>(sql`
      SELECT
        p.id AS product_id,
        p.sku AS sku,
        p.name AS name,
        coalesce(sum(li.max_uses - li.use_count), 0)::int AS available
      FROM products p
      LEFT JOIN license_items li
        ON li.product_id = p.id AND li.status = 'available'
      GROUP BY p.id, p.sku, p.name
      ORDER BY p.name ASC;
    `);
    const list = rows as unknown as Array<{
      product_id: string;
      sku: string;
      name: string;
      available: number;
    }>;
    let totalAvailable = 0;
    const byProduct: StockByProduct[] = list.map((r) => {
      const available = Number(r.available);
      totalAvailable += available;
      return { productId: r.product_id, sku: r.sku, name: r.name, available };
    });
    return { totalAvailable, byProduct };
  }

  /**
   * Satış hızı: assignments.created_at pencerelerinde (7/30 gün) tüketilen units
   * toplamı ürün bazında. dailyRate=sold30d/30; daysRemaining=available/dailyRate
   * (rate 0 → null). available, stock() ile AYNI 'available' kapasite mantığı.
   * Yalnız satış geçmişi olan (en az bir atama) ürünler listelenir.
   */
  private async velocity(): Promise<VelocityRow[]> {
    const rows = await this.db.execute<{
      product_id: string;
      sku: string;
      sold7d: number;
      sold30d: number;
      available: number;
    }>(sql`
      SELECT
        p.id AS product_id,
        p.sku AS sku,
        coalesce(sum(a.units) FILTER (WHERE a.created_at >= now() - interval '7 days'), 0)::int AS sold7d,
        coalesce(sum(a.units) FILTER (WHERE a.created_at >= now() - interval '30 days'), 0)::int AS sold30d,
        coalesce((
          SELECT sum(li.max_uses - li.use_count)
          FROM license_items li
          WHERE li.product_id = p.id AND li.status = 'available'
        ), 0)::int AS available
      FROM assignments a
      JOIN order_lines ol ON ol.id = a.line_id
      JOIN products p ON p.id = ol.product_id
      GROUP BY p.id, p.sku
      ORDER BY sold30d DESC, p.sku ASC;
    `);
    const list = rows as unknown as Array<{
      product_id: string;
      sku: string;
      sold7d: number;
      sold30d: number;
      available: number;
    }>;
    return list.map((r) => {
      const sold7d = Number(r.sold7d);
      const sold30d = Number(r.sold30d);
      const available = Number(r.available);
      const dailyRate = sold30d / 30;
      const daysRemaining = dailyRate > 0 ? Math.round(available / dailyRate) : null;
      // dailyRate'i sunum için 2 ondalığa yuvarla (daysRemaining ham orandan hesaplandı).
      return {
        productId: r.product_id,
        sku: r.sku,
        sold7d,
        sold30d,
        dailyRate: Math.round(dailyRate * 100) / 100,
        daysRemaining,
      };
    });
  }

  /**
   * Değişim/garanti talebi özeti (§13). replacement_requests tablosu bu modülde
   * drizzle şema olarak import EDİLMEZ — RAW SQL ile sayılır. rate=approved/max(total,1).
   */
  private async replacements(): Promise<ReportsOverview['replacements']> {
    const rows = await this.db.execute<{ total: number; approved: number }>(sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'approved')::int AS approved
      FROM replacement_requests;
    `);
    const list = rows as unknown as Array<{ total: number; approved: number }>;
    const total = Number(list[0]?.total ?? 0);
    const approved = Number(list[0]?.approved ?? 0);
    const rate = approved / Math.max(total, 1);
    return { total, approved, rate };
  }
}
