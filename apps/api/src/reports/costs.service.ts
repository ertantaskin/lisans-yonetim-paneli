import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { notExpiredCond } from '../assignment/assign';
import { STANDING_STATUSES } from '../assignment/assign';

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

/**
 * ── ZAMAN PENCERESİ (denetim bulgusu O7) ────────────────────────────────────────────────
 *
 * NEDEN: `deliveredCogs`/`wastage` (ve tedarikçi/ürün/ay kırılımları) hiçbir tarih süzgeci
 * ALMIYORDU. `/reports/costs` her açılışta `assignments × license_items` (sistemin en hızlı
 * büyüyen tablosu: sipariş × satır × birim) ve `stock_adjustments × license_items × batches ×
 * purchase_orders` zincirini BAŞTAN SONA tarıyordu. Rapor semantiği ZATEN "dönem maliyeti" —
 * pencere yanlış değil, EKSİKTİ.
 *
 * VARSAYILAN KARARI — "son 12 ay" (tüm zamanlar DEĞİL):
 *  • Varsayılanı "tüm zamanlar" bırakmak bulguyu KAPATMAZ: operatör hiçbir zaman elle tarih
 *    seçmez, yani sıcak yol (menüden tıklayıp raporu açmak) yine sınırsız tarama olurdu.
 *  • 12 ay bu raporun kendi diliyle uyumlu: aylık harcama zaten bir zaman serisi olarak
 *    çiziliyor ve tedarik kararları yıllık mevsimsellikle okunuyor.
 *  • SESSİZ KIRPMA YASAK (bu projenin değişmez kuralı): uygulanan pencere yanıtta `window`
 *    ile DÖNER ve ekranın başlığında yazılır; "Tüm zamanlar" tek tıkla seçilebilir
 *    (`?all=1`). Yani daraltma görünür ve geri alınabilir.
 *
 * ÜST SINIR BİLEREK AÇIK: varsayılanda yalnız ALT sınır konur (`to = null`). Üst sınırı
 * "şimdi" ile kapatmak, ileri tarihli teslim-alma damgası taşıyan partileri (stok girişi
 * `now + 24s`'e kadar kabul ediyor) sessizce dışarıda bırakırdı.
 */
export interface CostWindow {
  /** Alt sınır (DAHİL, ISO). null = alt sınır yok. */
  from: string | null;
  /** Üst sınır (DAHİL, ISO). null = üst sınır yok. */
  to: string | null;
  /** Operatör açıkça "tüm zamanlar" seçti mi (hiçbir sınır uygulanmaz). */
  allTime: boolean;
  /** Parametre verilmedi → varsayılan pencere uygulandı (ekran bunu açıkça yazar). */
  isDefault: boolean;
  /** Varsayılan pencerenin uzunluğu (ay) — ekran metni için TEK KAYNAK. */
  defaultMonths: number;
}

/** `getCostReport` parametreleri — hepsi opsiyonel (bkz. CostWindow). */
export interface CostReportParams {
  /** ISO tarih/zaman ya da `YYYY-MM-DD` (gün başı olarak yorumlanır). */
  from?: string;
  /** ISO tarih/zaman ya da `YYYY-MM-DD` (gün SONU olarak yorumlanır). */
  to?: string;
  /** true → hiçbir tarih sınırı uygulanmaz (eski davranış). */
  allTime?: boolean;
}

/** Yalnız gün taşıyan girdi (`<input type="date">` çıktısı) — saat bilgisi yok. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Satın alma emrinin HARCAMA anı (bySupplier/byProduct pencere kolonu).
 *
 * NEDEN `coalesce`: harcama teslim alındığında gerçekleşir (`spentCents` zaten
 * `qty_received` ile çarpılıyor), bu yüzden birincil kolon `received_at`'tir — ve bu,
 * ay kırılımının kullandığı `batches.received_at` ile AYNI takvimi verir (operatör stok
 * girişinde geçmiş bir teslim tarihi yazdığında iki blok aynı aya düşer; `created_at`
 * kullansaydık aynı ekranda iki farklı ay görünürdü).
 *
 * NEDEN yedek `created_at`: `received_at` YALNIZ emir tamamen teslim alındığında dolar
 * (`purchase-orders.service`), KISMEN teslim alınmış emirde NULL'dur ama `qty_received > 0`
 * olduğu için harcaması vardır. Yedeksiz bir süzgeç o emirleri SESSİZCE düşürürdü.
 *
 * İNDEKS: bu İFADE artık indekslidir — `purchase_orders_spent_at_idx`
 * (migration 0043, `btree(coalesce(received_at, created_at))`), yani dönem penceresi
 * (`?from&to`) indeksten karşılanır. (Eski not "ifade indeksi yok / DDL entegratöre
 * raporlandı" diyordu; 0043 o DDL'in ta kendisidir.) Mevcut `purchase_orders_created_idx`
 * bu ifadeyi KARŞILAMAZ — ikisi ayrı indeks olarak durmalıdır.
 */
const PO_SPENT_AT = 'coalesce(po.received_at, po.created_at)';

/**
 * Tarih sınırını ISO dizeye çevirir; ayrıştırılamayan/boş değerde null (sınır uygulanmaz).
 *
 * GÜN GİRDİSİ KENARI: `<input type="date">` "2026-08-15" gönderir. `new Date('2026-08-15')`
 * UTC gece yarısıdır → üst sınır olarak kullanılsaydı O GÜNÜN TAMAMI kapsam dışı kalırdı
 * (operatör "bugüne kadar" seçer, bugünün kayıtlarını göremezdi — sessiz eksik veri).
 * Bu yüzden gün girdisi YEREL gün başına (from) / gün sonuna (to) genişletilir.
 */
function parseBound(value: string | undefined, edge: 'start' | 'end'): string | null {
  const s = (value ?? '').trim();
  if (!s) return null;
  if (DATE_ONLY_RE.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    const dt =
      edge === 'start'
        ? new Date(y, m - 1, d, 0, 0, 0, 0)
        : new Date(y, m - 1, d, 23, 59, 59, 999);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/** Tedarikçi bazında harcama satırı (para birimi başına AYRI). */
export interface CostBySupplier {
  supplierId: string;
  supplier: string;
  currency: string;
  spentCents: number;
  poCount: number;
}

/**
 * Ay bazında harcama satırı (month "YYYY-MM"; para birimi başına AYRI).
 *
 * `uncoveredQty` (denetim bulgusu R9): maliyeti bağlanamayan teslim alma. Sorgu eskiden
 * `JOIN purchase_orders` (INNER) idi → satın alma emri OLMAYAN parti (tedarikçisiz elle
 * stok girişi) hiçbir aya GİRMİYOR, sessizce kayboluyordu. Artık aynı dosyadaki
 * `valuation`/`wastage`/`deliveredCogs` ile aynı dürüstlük: kapsanamayan miktar ayrı
 * kolonda sayılır (bilinmeyen para birimi = '' satırı) ve `spentCents`'e KATILMAZ.
 */
export interface CostByMonth {
  month: string;
  currency: string;
  spentCents: number;
  /** Maliyeti bağlanamayan (PO yok / unit_cost_cents NULL) teslim alınan adet. */
  uncoveredQty: number;
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
  /**
   * Uygulanan zaman penceresi (bkz. CostWindow). AKIŞ blokları (bySupplier/byMonth/
   * byProduct/wastage/deliveredCogs) bu pencereyle sınırlıdır.
   *
   * `valuation` İSTİSNADIR ve BİLEREK penceresizdir: "stok değeri" bir DÖNEM AKIŞI değil,
   * ŞU ANKİ pozisyondur. Pencereyle daraltmak "elimizdeki stok 3 ayda azaldı" gibi okunan
   * yanlış bir sayı üretirdi (kalemin ne zaman girdiği, bugün elde olup olmadığını
   * değiştirmez). Ekran bunu açıkça yazar.
   */
  window: CostWindow;
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
  /** Parametre verilmediğinde uygulanan pencere (ay). Gerekçe: CostWindow jsdoc'u. */
  static readonly DEFAULT_WINDOW_MONTHS = 12;

  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * İstenen pencereyi normalleştirir.
   *
   * GEÇERSİZ TARİH → O SINIR UYGULANMAZ; geriye HİÇ geçerli sınır kalmazsa VARSAYILAN
   * pencere devreye girer ("sınırsız"a düşmez). Gerekçe: bozuk bir girdinin ödülü tam-tablo
   * taraması olmamalı — bu bulgunun (O7) kendisi zaten sınırsız taramaydı. SLA'nın
   * `normalizeDays` deseniyle aynı yön: rapor OKUMA yolunda bozuk değer ekranı 400 ile
   * boşaltmaz, varsayılana düşer ve uygulanan pencere yanıtta görünür. Denetim (400)
   * controller katmanında yapılır.
   *
   * `from > to` DÜZELTİLMEZ (takas edilmez): sessiz düzeltme, operatörün yazdığı aralıktan
   * BAŞKA bir aralığın rakamlarını göstermek olurdu. Sonuç boş döner ve ekran hangi
   * pencerenin uygulandığını yazdığı için durum kendini açıklar.
   */
  private resolveWindow(params: CostReportParams): CostWindow {
    const defaultMonths = CostsService.DEFAULT_WINDOW_MONTHS;
    if (params.allTime) {
      return { from: null, to: null, allTime: true, isDefault: false, defaultMonths };
    }
    const from = parseBound(params.from, 'start');
    const to = parseBound(params.to, 'end');
    if (from || to) {
      return { from, to, allTime: false, isDefault: false, defaultMonths };
    }
    // Varsayılan: YALNIZ alt sınır (üst sınır açık — bkz. CostWindow jsdoc'u).
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setMonth(start.getMonth() - defaultMonths);
    return {
      from: start.toISOString(),
      to: null,
      allTime: false,
      isDefault: true,
      defaultMonths,
    };
  }

  /**
   * Tek bir tarih kolonu için pencere yüklemi.
   *
   * ISO DİZE + AÇIK `::timestamptz` (Date NESNESİ DEĞİL): bu fragmanlar ham `sql` şablonuyla
   * kurulup `rawRows` üzerinden sürücüye gidiyor; oraya bir `Date` konduğunda postgres.js
   * bind aşamasında ERR_INVALID_ARG_TYPE atar ve uç HER ZAMAN 500 döner (typecheck/build
   * bunu YAKALAMAZ — bu projede `/audit` tarih süzgecinde yaşandı, yalnız entegrasyon testi
   * yakaladı). Cast ŞART: cast'siz parametre `text` bind edilir, `timestamptz` ile
   * karşılaştırma 42883 verir. `audit.service` ile BİREBİR aynı desen.
   *
   * `expr` YALNIZ bu dosyada tanımlı sabit kolon ifadeleridir (kullanıcı girdisi DEĞİL) →
   * `sql.raw` güvenli.
   */
  private windowCond(expr: string, w: CostWindow): SQL {
    const conds: SQL[] = [sql`true`];
    if (w.from) conds.push(sql`${sql.raw(expr)} >= ${w.from}::timestamptz`);
    if (w.to) conds.push(sql`${sql.raw(expr)} <= ${w.to}::timestamptz`);
    return sql.join(conds, sql` AND `);
  }

  /**
   * Tüm maliyet blokları (pencere ile sınırlı; `valuation` hariç — ANLIK pozisyon).
   * Parametresiz çağrı varsayılan pencereyi (son 12 ay) uygular.
   */
  async getCostReport(params: CostReportParams = {}): Promise<CostReport> {
    const window = this.resolveWindow(params);
    const [bySupplier, byMonth, byProduct, valuation, wastage, deliveredCogs] = await Promise.all([
      this.bySupplier(window),
      this.byMonth(window),
      this.byProduct(window),
      this.valuation(),
      this.wastage(window),
      this.deliveredCogs(window),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      window,
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
   *
   * `::bigint` ÇARPANLARDA, sonuçta DEĞİL (bu dosyadaki üç sorguda da): Postgres'te
   * `int4 * int4` yine int4'tür ve TOPLAMAYA GİRMEDEN taşar (22003) — sum sonucuna
   * uygulanan cast çok geç kalır. Denetim sınırları bu değerlere izin veriyor
   * (`unitCostCents ≤ 2e9`, `qtyOrdered ≤ 1e6`), yani 500 adet × 43.000 ₺ gibi GERÇEKÇİ
   * bir alım raporu ham 500'e düşürebilirdi. Aynı kusur tedarikçi karnesinde bulundu
   * (`procurement/suppliers.service.ts`) ve orada bir regresyon testiyle kilitlendi.
   *
   * PENCERE: `coalesce(po.received_at, po.created_at)` — gerekçe PO_SPENT_AT jsdoc'unda.
   */
  private async bySupplier(w: CostWindow): Promise<CostBySupplier[]> {
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
        coalesce(sum(po.qty_received::bigint * coalesce(po.unit_cost_cents, 0)::bigint), 0)::bigint AS spent_cents,
        count(*)::int AS po_count
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id
      WHERE ${this.windowCond(PO_SPENT_AT, w)}
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
   * batches.qty_received × PO.unit_cost_cents. En eski ay önce.
   *
   * KAPSANAMAYAN (denetim bulgusu R9): join eskiden INNER idi → satın alma emrine BAĞLI
   * OLMAYAN parti (tedarikçisiz elle stok girişi; `batches.purchase_order_id` NULL) aylık
   * seriye HİÇ girmiyordu. Ekran "bu ay şu kadar harcadık" derken o teslim almalar sessizce
   * yok sayılıyordu — panelin başka hiçbir yerinde bu boşluk raporlanmıyordu. Artık LEFT JOIN
   * + `uncoveredQty`: miktar görünür, parasal toplama KATILMAZ (uydurma maliyet yazılmaz).
   * Para birimi bilinmiyorsa satır '' currency ile döner (valuation/deliveredCogs deseni).
   *
   * PENCERE: `b.received_at` (teslim alma anı — kova zaten bu kolondan üretiliyor).
   * Kolon FONKSİYONA SARILMADAN süzülür → `batches_received_idx` kullanılabilir kalır;
   * ay etiketi yalnız SELECT/GROUP BY tarafında `to_char` ile üretilir (SLA'daki desen).
   */
  private async byMonth(w: CostWindow): Promise<CostByMonth[]> {
    const list = await rawRows<{
      month: string;
      currency: string;
      spent_cents: number;
      uncovered_qty: number;
    }>(this.db, sql`
      SELECT
        to_char(b.received_at, 'YYYY-MM') AS month,
        coalesce(po.currency, '') AS currency,
        coalesce(
          sum(b.qty_received::bigint * po.unit_cost_cents::bigint)
            FILTER (WHERE po.unit_cost_cents IS NOT NULL),
          0
        )::bigint AS spent_cents,
        coalesce(sum(b.qty_received) FILTER (WHERE po.unit_cost_cents IS NULL), 0)::int
          AS uncovered_qty
      FROM batches b
      LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id
      WHERE b.received_at IS NOT NULL AND ${this.windowCond('b.received_at', w)}
      GROUP BY to_char(b.received_at, 'YYYY-MM'), coalesce(po.currency, '')
      ORDER BY month ASC, currency ASC;
    `);
    return list.map((r) => ({
      month: r.month,
      currency: r.currency,
      spentCents: Number(r.spent_cents),
      uncoveredQty: Number(r.uncovered_qty),
    }));
  }

  /**
   * Ürün × para birimi bazında harcama + teslim alınan miktar. spentCents = teslim
   * alınan miktar × birim maliyet.
   *
   * PENCERE: bySupplier ile AYNI kolon (PO_SPENT_AT) — iki kırılım aynı emir kümesini
   * saymazsa aynı ekranda toplamları tutmayan iki grafik çıkardı.
   */
  private async byProduct(w: CostWindow): Promise<CostByProduct[]> {
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
        coalesce(sum(po.qty_received::bigint * coalesce(po.unit_cost_cents, 0)::bigint), 0)::bigint AS spent_cents,
        coalesce(sum(po.qty_received), 0)::int AS qty_received
      FROM purchase_orders po
      JOIN products p ON p.id = po.product_id
      WHERE ${this.windowCond(PO_SPENT_AT, w)}
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
   *
   * PENCERESİZ (BİLİNÇLİ): bu blok bir DÖNEM AKIŞI değil, ŞU ANKİ pozisyondur — "elimde
   * bugün duran satılabilir stoğun maliyeti". Tarih aralığıyla daraltmak, bugün elde olan
   * ama pencereden önce girmiş kalemleri yok sayıp "stok değerimiz düştü" yalanını
   * söylerdi. `WHERE li.status = 'available'` zaten kısmi indekslerle karşılanıyor.
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
   *
   * PENCERE: `sa.created_at` = DÜZELTMENİN yazıldığı an (void/damage/recall olayının
   * tarihi). Kalemin stoğa GİRİŞ tarihi DEĞİL: "bu dönemde ne kadar zayi verdik" sorusunun
   * cevabı olayın kendi tarihine bağlıdır (üç yıl önce alınmış bir anahtar bu ay imha
   * edildiyse zayiat BU AYINDIR). Tablo append-only ve büyüyor; süzgeç `license_items ×
   * batches × purchase_orders` zincirini kurmadan ÖNCE satırları eler.
   */
  private async wastage(w: CostWindow): Promise<CostWastage[]> {
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
        AND ${this.windowCond('sa.created_at', w)}
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
   * Teslim edilen COGS (§12, D17): AYAKTA + teslim edilmiş (delivered_at IS NOT NULL)
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
   *
   * AYAKTA KÜMESİ (denetim bulgusu R4): yüklem `a.status = 'active'` idi; oysa panelin
   * "ayakta" tanımı HER YERDE `active | suspended | expired` (reconcile mutabakatı,
   * reports velocity, ürün hızları — bkz. assignment/assign.ts).
   *  • `suspended` anahtar müşterinin ELİNDEDİR, yalnız geçici olarak gizlenmiştir (§4) —
   *    iade DEĞİLDİR; maliyeti oluşmuştur.
   *  • Süresi dolmuş (`expired`) süreli hesap da teslim EDİLMİŞTİ ve §2 gereği hak geri
   *    gelmez (kapasite havuza dönmez) — maliyeti oluşmuştur.
   * İkisi de dışlandığı için AYNI EKRANDAKİ satış hızı (velocity) ile COGS ÇELİŞİYORDU:
   * bir anahtar askıya alınır alınmaz "satıldı ama maliyeti yok" gibi görünüyordu.
   * `revoked`/`replaced` HÂLÂ hariç (gerçek iade + değişimde net'lenen eski atama).
   *
   * PENCERE: `a.delivered_at` = TESLİM anı (sorgu zaten `IS NOT NULL` süzüyor, yani
   * kolonun tanımlı olduğu kümede çalışıyoruz). `created_at` seçilmedi: bu blok "bu dönemde
   * teslim edilen malın maliyeti"ni ölçer, atamanın satır olarak yazıldığı anı değil.
   *
   * İNDEKS: `delivered_at` artık İNDEKSLİ — `assignments_delivered_at_idx`
   * (migration 0043, `btree(delivered_at) WHERE delivered_at IS NOT NULL`), yani istenen
   * KISMİ indeksin ta kendisi eklendi ve sorgunun `IS NOT NULL` süzgeci onunla birebir
   * örtüşür. (Eski not "indekssiz / DDL entegratöre raporlandı, migration EKLENMEDİ"
   * diyordu — 0043 ile geçersiz kaldı.)
   */
  private async deliveredCogs(w: CostWindow): Promise<CostDeliveredCogs[]> {
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
      /* AYAKTA atamalar — TEK KAYNAK (assignment/assign.ts). Bkz. metot jsdoc'u:
         yalnız 'active' saymak askıdaki ve süresi dolmuş TESLİMATLARI maliyetten düşürüyordu. */
      WHERE a.status IN ${STANDING_STATUSES} AND a.delivered_at IS NOT NULL
        AND ${this.windowCond('a.delivered_at', w)}
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
