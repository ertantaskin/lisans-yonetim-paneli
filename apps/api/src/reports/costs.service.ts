import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { notExpiredCond } from '../assignment/assign';

/**
 * ANAHTAR-BAŞI MALİYETİ KULLANIMA ORANLA (denetim bulgusu).
 *
 * `unit_cost_cents` (PO birim maliyeti / license_items snapshot'ı) BİR ANAHTARIN maliyetidir,
 * bir KULLANIMIN değil. Çok kullanımlık (multi/MAK) üründe kapasite birimini bu tutarla
 * çarpmak maliyeti max_uses KATI şişiriyordu: 500 kullanımlık, 10 ₺'ye alınmış bir MAK
 * anahtarı stok değerlemede 5.000 ₺ görünüyor, aynı raporda tedarik harcaması 10 ₺ diyordu
 * (aynı ekranda çelişen iki sayı → operatör hangisine güveneceğini bilemiyordu).
 *
 * Doğrusu: birim × (anahtar maliyeti / anahtarın toplam kapasitesi).
 * Tek kullanımda max_uses=1 olduğundan sonuç DEĞİŞMEZ (birebir geriye dönük uyumlu).
 * `GREATEST(max_uses, 1)` sıfıra bölmeye karşı savunmadır (NULL max_uses'te de 1 döner).
 */
const PRORATED_COST = (units: string, cost: string, maxUses: string) =>
  sql.raw(`(${cost}::numeric * ${units} / GREATEST(${maxUses}, 1))`);

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
 *
 * `valuedCents` kapasiteyi ANAHTAR başına maliyete ORANLAR (bkz. PRORATED_COST) — MAK
 * kapasitesi anahtar maliyetiyle çarpılıp raporu şişirmez.
 */
export interface CostValuation {
  currency: string;
  valuedCents: number;
  valuedUnits: number;
  uncoveredUnits: number;
  /**
   * status='available' AMA stok ömrü (expires_at) dolmuş kapasite — ATANAMAZ, bu yüzden
   * valuedUnits/uncoveredUnits'e GİRMEZ. Sessizce kaybolmasın diye ayrı raporlanır
   * (fiilen zayi: "elimizde duruyor ama satılamıyor").
   */
  expiredUnits: number;
  /** expiredUnits'in oranlanmış parasal karşılığı (maliyeti bağlanabilenler için). */
  expiredCents: number;
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
 * Teslim edilen COGS satırı (para birimi başına, §12 D17). Aktif + teslim edilmiş
 * atamaların license_items maliyet anlık-görüntüsü (unit_cost_cents) üzerinden hesap.
 * Snapshot NULL olan (import anında partiye/PO'ya bağlanamayan) atamalar uncoveredUnits
 * olarak AYRI sayılır (currency='' satırı) — sessiz sıfırlanmaz.
 */
export interface CostDeliveredCogs {
  currency: string;
  cogsCents: number;
  deliveredUnits: number;
  uncoveredUnits: number;
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
  deliveredCogs: CostDeliveredCogs[];
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
    const [bySupplier, byMonth, byProduct, valuation, wastage, deliveredCogs] = await Promise.all([
      this.bySupplier(),
      this.byMonth(),
      this.byProduct(),
      this.valuation(),
      this.wastage(),
      this.deliveredCogs(),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      bySupplier,
      byMonth,
      byProduct,
      valuation,
      wastage,
      deliveredCogs,
    };
  }

  /**
   * Tedarikçi × para birimi bazında gerçekleşen harcama. spentCents = teslim alınan
   * miktar × birim maliyet (qty_received × coalesce(unit_cost_cents, 0)). Para birimi
   * karışımı ayrı satırlar (GROUP BY currency).
   */
  private async bySupplier(): Promise<CostBySupplier[]> {
    const list = await rawRows<{
      supplier_id: string;
      supplier: string;
      currency: string;
      spent_cents: number;
      po_count: number;
    }>(this.db, sql`
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
    return list.map((r) => ({
      supplierId: r.supplier_id,
      supplier: r.supplier,
      currency: r.currency,
      spentCents: Number(r.spent_cents),
      poCount: Number(r.po_count),
    }));
  }

  /**
   * Ay (TESLİM ALMA anı → "YYYY-MM") × para birimi bazında gerçekleşen harcama.
   * Kova PO oluşturma ayına DEĞİL, parti teslim-alma ayına göredir (M1'de açılıp M2/M3'te
   * teslim alınan PO'nun harcaması teslim ayına düşer). Parti başına toplanır:
   * batches.qty_received × PO.unit_cost_cents, batches → purchase_orders join. En eski ay önce.
   */
  private async byMonth(): Promise<CostByMonth[]> {
    const list = await rawRows<{
      month: string;
      currency: string;
      spent_cents: number;
    }>(this.db, sql`
      SELECT
        to_char(b.received_at, 'YYYY-MM') AS month,
        po.currency AS currency,
        coalesce(sum(b.qty_received * coalesce(po.unit_cost_cents, 0)), 0)::bigint AS spent_cents
      FROM batches b
      JOIN purchase_orders po ON po.id = b.purchase_order_id
      WHERE b.received_at IS NOT NULL
      GROUP BY to_char(b.received_at, 'YYYY-MM'), po.currency
      ORDER BY month ASC, currency ASC;
    `);
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
    const list = await rawRows<{
      product_id: string;
      product: string;
      currency: string;
      spent_cents: number;
      qty_received: number;
    }>(this.db, sql`
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
   * purchase_orders.unit_cost_cents ile ORANLANMIŞ birim maliyet × kalan kapasite
   * (max_uses - use_count), para birimine göre gruplu. Maliyeti bağlanamayan
   * (batch_id NULL / PO yok / PO cost NULL) kapasite uncoveredUnits olarak AYRI
   * sayılır (bilinmeyen para birimi = '' satırı); sessiz sıfırlanmaz.
   *
   * İki düzeltme (denetim):
   *  1. Parasal toplam artık ANAHTAR başına oranlanır (PRORATED_COST) — MAK'ta max_uses
   *     katı şişme yok; tek kullanımda sonuç birebir aynı.
   *  2. Stok ömrü dolmuş (expires_at ≤ now) kalemler atama sorgusunda ZATEN dışlanıyor →
   *     "değerlenen satılabilir stok"a girmezler; `expiredUnits/expiredCents` olarak ayrı
   *     raporlanır (notExpiredCond — atama yoluyla TEK KAYNAK).
   */
  private async valuation(): Promise<CostValuation[]> {
    const remaining = 'GREATEST(li.max_uses - li.use_count, 0)';
    const cost = PRORATED_COST(remaining, 'po.unit_cost_cents', 'li.max_uses');
    const fresh = notExpiredCond('li');
    const list = await rawRows<{
      currency: string;
      valued_cents: number;
      valued_units: number;
      uncovered_units: number;
      expired_units: number;
      expired_cents: number;
    }>(this.db, sql`
      SELECT
        coalesce(po.currency, '') AS currency,
        coalesce(
          round(sum(${cost}) FILTER (WHERE po.unit_cost_cents IS NOT NULL AND ${fresh})),
          0
        )::bigint AS valued_cents,
        coalesce(
          sum(${sql.raw(remaining)}) FILTER (WHERE po.unit_cost_cents IS NOT NULL AND ${fresh}),
          0
        )::int AS valued_units,
        coalesce(
          sum(${sql.raw(remaining)}) FILTER (WHERE po.unit_cost_cents IS NULL AND ${fresh}),
          0
        )::int AS uncovered_units,
        coalesce(
          sum(${sql.raw(remaining)}) FILTER (WHERE NOT ${fresh}),
          0
        )::int AS expired_units,
        coalesce(
          round(sum(${cost}) FILTER (WHERE po.unit_cost_cents IS NOT NULL AND NOT ${fresh})),
          0
        )::bigint AS expired_cents
      FROM license_items li
      LEFT JOIN batches b ON b.id = li.batch_id
      LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id
      WHERE li.status = 'available'
      GROUP BY coalesce(po.currency, '')
      ORDER BY currency ASC;
    `);
    return list.map((r) => ({
      currency: r.currency,
      valuedCents: Number(r.valued_cents),
      valuedUnits: Number(r.valued_units),
      uncoveredUnits: Number(r.uncovered_units),
      expiredUnits: Number(r.expired_units),
      expiredCents: Number(r.expired_cents),
    }));
  }

  /**
   * Fire/zayiat: stock_adjustments (action void/damage/recall) miktarı × ilgili ORANLANMIŞ
   * birim maliyet. Birim maliyet license_item_id → batches → purchase_orders üzerinden
   * bağlanır (FK yok, RAW join). Maliyeti bağlanamayan olaylar uncoveredEvents olarak
   * AYRI sayılır. qty defansif olarak abs() ile alınır. Para birimine göre gruplu.
   *
   * ORANLAMA (denetim): `sa.qty` MAK/multi'de KALAN KAPASİTE'dir (voidLicenseItem ve
   * supply-ops recall bu şekilde yazar) — anahtar sayısı değil. Anahtar başına maliyetle
   * doğrudan çarpmak zayiatı max_uses katı gösteriyordu; artık kapasite oranı kadar
   * yazılır (tek kullanımda qty=1, max_uses=1 → sonuç değişmez).
   */
  private async wastage(): Promise<CostWastage[]> {
    const wastedCost = PRORATED_COST('abs(sa.qty)', 'po.unit_cost_cents', 'li.max_uses');
    const list = await rawRows<{
      currency: string;
      wasted_cents: number;
      events: number;
      uncovered_events: number;
    }>(this.db, sql`
      SELECT
        coalesce(po.currency, '') AS currency,
        coalesce(
          round(sum(${wastedCost}) FILTER (WHERE po.unit_cost_cents IS NOT NULL)),
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
    return list.map((r) => ({
      currency: r.currency,
      wastedCents: Number(r.wasted_cents),
      events: Number(r.events),
      uncoveredEvents: Number(r.uncovered_events),
    }));
  }

  /**
   * Teslim edilen COGS (§12, D17): AKTİF + teslim edilmiş (delivered_at IS NOT NULL)
   * atamaların, bağlı license_item maliyet anlık-görüntüsü (unit_cost_cents) üzerinden
   * teslim maliyeti. Maliyet PO join'iyle DEĞİL, satırda saklı SNAPSHOT ile hesaplanır
   * (PO sonradan değişse bile teslim maliyeti sabit). Para birimi snapshot'tan (cost_currency)
   * alınır ve AYRI gruplanır. Snapshot NULL olan atamalar uncoveredUnits olarak AYRI
   * sayılır (currency='' satırı) — sessiz sıfırlanmaz.
   *
   * ORANLAMA (denetim): `a.units` KULLANIM birimidir; MAK anahtarında bir atama 500'lük
   * kapasitenin yalnız birkaç birimini tüketir. Anahtar maliyetini units ile doğrudan
   * çarpmak COGS'u anahtarın TAM maliyeti kadar (hatta katı) gösteriyordu; artık tüketilen
   * kapasite oranı yazılır (tek kullanımda units=1, max_uses=1 → sonuç birebir aynı).
   */
  private async deliveredCogs(): Promise<CostDeliveredCogs[]> {
    const cogs = PRORATED_COST('a.units', 'li.unit_cost_cents', 'li.max_uses');
    const list = await rawRows<{
      currency: string;
      cogs_cents: number;
      delivered_units: number;
      uncovered_units: number;
    }>(this.db, sql`
      SELECT
        coalesce(li.cost_currency, '') AS currency,
        coalesce(
          round(sum(${cogs}) FILTER (WHERE li.unit_cost_cents IS NOT NULL)),
          0
        )::bigint AS cogs_cents,
        coalesce(
          sum(a.units) FILTER (WHERE li.unit_cost_cents IS NOT NULL),
          0
        )::int AS delivered_units,
        coalesce(
          sum(a.units) FILTER (WHERE li.unit_cost_cents IS NULL),
          0
        )::int AS uncovered_units
      FROM assignments a
      JOIN license_items li ON li.id = a.license_item_id
      WHERE a.status = 'active' AND a.delivered_at IS NOT NULL
      GROUP BY coalesce(li.cost_currency, '')
      ORDER BY currency ASC;
    `);
    return list.map((r) => ({
      currency: r.currency,
      cogsCents: Number(r.cogs_cents),
      deliveredUnits: Number(r.delivered_units),
      uncoveredUnits: Number(r.uncovered_units),
    }));
  }
}
