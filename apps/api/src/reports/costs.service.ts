import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';

/** Tedarikçi bazında harcama satırı (para birimi başına AYRI). */
export interface CostBySupplier {
  supplierId: string;
  supplier: string;
  currency: string;
  spentCents: number;
  poCount: number;
}

/** Ay bazında harcama satırı (month "YYYY-MM"; para birimi başına AYRI). */
export interface CostByMonth {
  month: string;
  currency: string;
  spentCents: number;
}

/** Ürün bazında harcama satırı (para birimi başına AYRI). */
export interface CostByProduct {
  productId: string;
  product: string;
  currency: string;
  spentCents: number;
  qtyReceived: number;
}

/**
 * Mevcut stok değerleme satırı (para birimi başına). Maliyeti PO'ya bağlanamayan
 * (batch_id NULL / PO yok / PO cost NULL) kapasite uncoveredUnits olarak AYRI sayılır
 * (currency='' satırı) — sessiz sıfırlanmaz.
 */
export interface CostValuation {
  currency: string;
  valuedCents: number;
  valuedUnits: number;
  uncoveredUnits: number;
}

/**
 * Fire/zayiat satırı (para birimi başına). void/damage/recall düzeltmelerinin
 * miktarı × ilgili birim maliyet. Maliyeti bağlanamayan olaylar uncoveredEvents
 * olarak AYRI sayılır.
 */
export interface CostWastage {
  currency: string;
  wastedCents: number;
  events: number;
  uncoveredEvents: number;
}

/**
 * Maliyet raporu (§12/§13) — salt-okunur agregasyon. TÜM tutarlar integer kuruş.
 * Panel ödemeye dokunmaz: bu rapor KÂR değil, YALNIZ MALİYET (PO unit_cost) yansıtır.
 * Para birimi karışımı tek toplamda birleştirilmez — her para birimi ayrı satır.
 */
export interface CostReport {
  generatedAt: string;
  bySupplier: CostBySupplier[];
  byMonth: CostByMonth[];
  byProduct: CostByProduct[];
  valuation: CostValuation[];
  wastage: CostWastage[];
}

/**
 * CostsService — maliyet agregasyonları (§12/§13). Hiçbir yazma/yan etki yapmaz;
 * yalnız mevcut tablolardan (purchase_orders, batches, license_items,
 * stock_adjustments, products, suppliers) RAW SQL ile özet üretir. Boş veri →
 * boş diziler (patlamaz). Satış fiyatı/gelir/kâr YOKTUR — panel ödemeye dokunmaz.
 */
@Injectable()
export class CostsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Tüm maliyet bloklarını paralel toplayıp tek rapor nesnesi döndürür. */
  async getCostReport(): Promise<CostReport> {
    const [bySupplier, byMonth, byProduct, valuation, wastage] = await Promise.all([
      this.bySupplier(),
      this.byMonth(),
      this.byProduct(),
      this.valuation(),
      this.wastage(),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      bySupplier,
      byMonth,
      byProduct,
      valuation,
      wastage,
    };
  }

  /**
   * Tedarikçi × para birimi bazında gerçekleşen harcama. spentCents = teslim alınan
   * miktar × birim maliyet (qty_received × coalesce(unit_cost_cents, 0)). Para birimi
   * karışımı ayrı satırlar (GROUP BY currency).
   */
  private async bySupplier(): Promise<CostBySupplier[]> {
    const rows = await this.db.execute<{
      supplier_id: string;
      supplier: string;
      currency: string;
      spent_cents: number;
      po_count: number;
    }>(sql`
      SELECT
        po.supplier_id AS supplier_id,
        s.name AS supplier,
        po.currency AS currency,
        coalesce(sum(po.qty_received * coalesce(po.unit_cost_cents, 0)), 0)::bigint AS spent_cents,
        count(*)::int AS po_count
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id
      GROUP BY po.supplier_id, s.name, po.currency
      ORDER BY spent_cents DESC, s.name ASC;
    `);
    const list = rows as unknown as Array<{
      supplier_id: string;
      supplier: string;
      currency: string;
      spent_cents: number;
      po_count: number;
    }>;
    return list.map((r) => ({
      supplierId: r.supplier_id,
      supplier: r.supplier,
      currency: r.currency,
      spentCents: Number(r.spent_cents),
      poCount: Number(r.po_count),
    }));
  }

  /**
   * Ay (created_at → "YYYY-MM") × para birimi bazında harcama. spentCents = teslim
   * alınan miktar × birim maliyet. En eski ay önce.
   */
  private async byMonth(): Promise<CostByMonth[]> {
    const rows = await this.db.execute<{
      month: string;
      currency: string;
      spent_cents: number;
    }>(sql`
      SELECT
        to_char(created_at, 'YYYY-MM') AS month,
        currency AS currency,
        coalesce(sum(qty_received * coalesce(unit_cost_cents, 0)), 0)::bigint AS spent_cents
      FROM purchase_orders
      GROUP BY to_char(created_at, 'YYYY-MM'), currency
      ORDER BY month ASC, currency ASC;
    `);
    const list = rows as unknown as Array<{
      month: string;
      currency: string;
      spent_cents: number;
    }>;
    return list.map((r) => ({
      month: r.month,
      currency: r.currency,
      spentCents: Number(r.spent_cents),
    }));
  }

  /**
   * Ürün × para birimi bazında harcama + teslim alınan miktar. spentCents = teslim
   * alınan miktar × birim maliyet.
   */
  private async byProduct(): Promise<CostByProduct[]> {
    const rows = await this.db.execute<{
      product_id: string;
      product: string;
      currency: string;
      spent_cents: number;
      qty_received: number;
    }>(sql`
      SELECT
        po.product_id AS product_id,
        p.name AS product,
        po.currency AS currency,
        coalesce(sum(po.qty_received * coalesce(po.unit_cost_cents, 0)), 0)::bigint AS spent_cents,
        coalesce(sum(po.qty_received), 0)::int AS qty_received
      FROM purchase_orders po
      JOIN products p ON p.id = po.product_id
      GROUP BY po.product_id, p.name, po.currency
      ORDER BY spent_cents DESC, p.name ASC;
    `);
    const list = rows as unknown as Array<{
      product_id: string;
      product: string;
      currency: string;
      spent_cents: number;
      qty_received: number;
    }>;
    return list.map((r) => ({
      productId: r.product_id,
      product: r.product,
      currency: r.currency,
      spentCents: Number(r.spent_cents),
      qtyReceived: Number(r.qty_received),
    }));
  }

  /**
   * Mevcut stok değerleme: available license_items → batch_id → batches →
   * purchase_orders.unit_cost_cents ile birim maliyet × kalan kapasite
   * (max_uses - use_count), para birimine göre gruplu. Maliyeti bağlanamayan
   * (batch_id NULL / PO yok / PO cost NULL) kapasite uncoveredUnits olarak AYRI
   * sayılır (bilinmeyen para birimi = '' satırı); sessiz sıfırlanmaz.
   */
  private async valuation(): Promise<CostValuation[]> {
    const rows = await this.db.execute<{
      currency: string;
      valued_cents: number;
      valued_units: number;
      uncovered_units: number;
    }>(sql`
      SELECT
        coalesce(po.currency, '') AS currency,
        coalesce(
          sum((li.max_uses - li.use_count) * po.unit_cost_cents)
            FILTER (WHERE po.unit_cost_cents IS NOT NULL),
          0
        )::bigint AS valued_cents,
        coalesce(
          sum(li.max_uses - li.use_count) FILTER (WHERE po.unit_cost_cents IS NOT NULL),
          0
        )::int AS valued_units,
        coalesce(
          sum(li.max_uses - li.use_count) FILTER (WHERE po.unit_cost_cents IS NULL),
          0
        )::int AS uncovered_units
      FROM license_items li
      LEFT JOIN batches b ON b.id = li.batch_id
      LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id
      WHERE li.status = 'available'
      GROUP BY coalesce(po.currency, '')
      ORDER BY currency ASC;
    `);
    const list = rows as unknown as Array<{
      currency: string;
      valued_cents: number;
      valued_units: number;
      uncovered_units: number;
    }>;
    return list.map((r) => ({
      currency: r.currency,
      valuedCents: Number(r.valued_cents),
      valuedUnits: Number(r.valued_units),
      uncoveredUnits: Number(r.uncovered_units),
    }));
  }

  /**
   * Fire/zayiat: stock_adjustments (action void/damage/recall) miktarı × ilgili birim
   * maliyet. Birim maliyet license_item_id → batches → purchase_orders üzerinden
   * bağlanır (FK yok, RAW join). Maliyeti bağlanamayan olaylar uncoveredEvents olarak
   * AYRI sayılır. qty defansif olarak abs() ile alınır. Para birimine göre gruplu.
   */
  private async wastage(): Promise<CostWastage[]> {
    const rows = await this.db.execute<{
      currency: string;
      wasted_cents: number;
      events: number;
      uncovered_events: number;
    }>(sql`
      SELECT
        coalesce(po.currency, '') AS currency,
        coalesce(
          sum(abs(sa.qty) * po.unit_cost_cents) FILTER (WHERE po.unit_cost_cents IS NOT NULL),
          0
        )::bigint AS wasted_cents,
        count(*) FILTER (WHERE po.unit_cost_cents IS NOT NULL)::int AS events,
        count(*) FILTER (WHERE po.unit_cost_cents IS NULL)::int AS uncovered_events
      FROM stock_adjustments sa
      LEFT JOIN license_items li ON li.id = sa.license_item_id
      LEFT JOIN batches b ON b.id = li.batch_id
      LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id
      WHERE sa.action IN ('void', 'damage', 'recall')
      GROUP BY coalesce(po.currency, '')
      ORDER BY currency ASC;
    `);
    const list = rows as unknown as Array<{
      currency: string;
      wasted_cents: number;
      events: number;
      uncovered_events: number;
    }>;
    return list.map((r) => ({
      currency: r.currency,
      wastedCents: Number(r.wasted_cents),
      events: Number(r.events),
      uncoveredEvents: Number(r.uncovered_events),
    }));
  }
}
