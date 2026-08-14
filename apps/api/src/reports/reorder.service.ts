import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';

/**
 * YENİDEN-SİPARİŞ ÖNERİSİ — "tedarik süresi içinde tükenecekler".
 *
 * NEDEN VAR: bugünkü düşük-stok alarmı SABİT bir eşiğe bakar (`products.low_stock_threshold`).
 * Sabit eşik tedarikçinin TESLİM SÜRESİNİ bilmez: 12 gün sonra mal getiren bir tedarikçide
 * "20'nin altına düştü" alarmı çaldığında sipariş vermek çoktan geç olabilir. Bu rapor eşiği
 * hızdan + tedarik süresinden TÜRETİR.
 *
 * ── FORMÜL (ekranda da aynen yazılır — sihirli sayı yok) ─────────────────────────────────
 *   günlük hız            = son ${REORDER_WINDOW_DAYS} günde tüketilen birim / ${REORDER_WINDOW_DAYS}
 *   tahmini tükenme (gün) = eldeki kullanılabilir birim / günlük hız
 *   yeniden sipariş noktası = günlük hız × (tedarik süresi + emniyet payı)
 *   önerilen birim          = günlük hız × (tedarik süresi + emniyet payı + hedef stok günü)
 *                             − eldeki birim − açık emirlerde bekleyen birim
 *   önerilen adet (anahtar) = ceil(önerilen birim / anahtar başına kullanım)
 *
 * SABİTLER ve GEREKÇELERİ (yanıtta `params` ile döner → arayüz kendi metnini uydurmaz):
 *   • emniyet payı  = ${SAFETY_DAYS} gün — tedarik süresi bir ORTALAMADIR; sapma + hafta sonu
 *     + gümrük/ödeme gecikmesi için tampon. Sıfır alınsaydı her ikinci alım geç kalırdı.
 *   • hedef stok günü = ${TARGET_COVER_DAYS} gün — siparişi kaç günlük talebi karşılayacak
 *     büyüklükte verelim (her hafta yeniden emir açmamak için). Velocity penceresiyle aynı.
 *
 * ── TEDARİK SÜRESİ BİLİNMİYORSA ─────────────────────────────────────────────────────────
 * `avgLeadDays` (SuppliersService karnesiyle BİREBİR aynı yüklem: `avg(received_at −
 * ordered_at)`, YALNIZ `status='received'` ve iki tarihi de dolu emirler) null olabilir:
 * ürünün hiç kapanmış satın alma emri yoksa ya da yalnız Stok Girişi'nden açılan otomatik
 * emirler varsa (`ordered_at` bilerek NULL). Bu durumda ÖNERİ ÜRETİLMEZ — varsayılan bir
 * süre uydurmak operatöre yanlış bir kesinlik satardı. Satır `status='unknown_lead'` ile
 * listelenir ve arayüz "tedarik süresi bilinmiyor — ilk kapanan emirden sonra hesaplanır" der.
 *
 * ── BİRİM MANTIĞI (MAK / çok kullanımlı) ────────────────────────────────────────────────
 * Stok, satış hızı ve öneri BİRİM (kullanım hakkı) uzayında hesaplanır:
 *   eldeki birim = Σ (max_uses − use_count)          — `available` ile aynı tanım
 *   tüketim      = Σ assignments.units
 * Ama satın alma emri ADET (anahtar) uzayındadır. Bu yüzden:
 *   açık emir birimi = açık emir adedi × anahtar başına kullanım (multi'de `max_uses`, aksi 1)
 *   önerilen adet    = ceil(önerilen birim / anahtar başına kullanım)
 * İkisi karıştırılırsa MAK ürününde 500 kat hatalı öneri çıkar.
 *
 * ── HESABA KATILMAYANLAR ────────────────────────────────────────────────────────────────
 *  • `products.stockless = true` (ön sipariş/stoksuz): stok tutmaz, tükenmez.
 *  • Son ${REORDER_WINDOW_DAYS} günde HİÇ satışı olmayan ürün: tükenme tarihi türetilemez
 *    (0'a bölme). Sayısı `excluded.noSalesProducts` ile dürüstçe raporlanır.
 *  • İptal edilmiş satırların (`order_lines.canceled`) atamaları ve iade/değişimde düşen
 *    atamalar (`revoked`/`replaced`) satış SAYILMAZ — `reports.velocity` ile aynı küme
 *    (`active`/`suspended`/`expired`), yoksa hız şişer ve gereğinden erken/çok sipariş verilir.
 *  • Süresi geçmiş (`expires_at <= now()`) kalem stok sayılmaz — atama sorgusuyla aynı yüklem.
 *
 * Salt-okunur: hiçbir yazma/yan etki yok. Yeni tablo/migration YOK.
 */

/** Satış hızı penceresi (gün) — `reports.velocity` ile AYNI ki iki ekran çelişmesin. */
export const REORDER_WINDOW_DAYS = 30;
/** Emniyet payı (gün) — tedarik süresi sapması için tampon. */
export const SAFETY_DAYS = 7;
/** Hedef stok günü — sipariş kaç günlük talebi karşılasın. */
export const TARGET_COVER_DAYS = 30;
/** Satır tavanı (tavan+1 çekilir → `truncated` HAM satır sayısından). */
export const REORDER_ROW_LIMIT = 200;

/**
 * Satır durumu:
 *  - `out`          : elde kullanılabilir birim kalmadı (satış sürüyor) — en acil.
 *  - `order_now`    : stok yeniden sipariş noktasının altında → ŞİMDİ emir açılmalı.
 *  - `watch`        : hedef stok günü penceresine girdi → yakında gerekecek.
 *  - `ok`           : yeterli.
 *  - `unknown_lead` : tedarik süresi bilinmiyor → öneri üretilmedi (dürüst boşluk).
 */
export type ReorderStatus = 'out' | 'order_now' | 'watch' | 'ok' | 'unknown_lead';

export interface ReorderRow {
  productId: string;
  sku: string;
  name: string;
  usageMode: 'single' | 'multi';
  /** multi'de anahtar başına kullanım hakkı (birim ↔ adet çevirisi bunu kullanır). */
  unitsPerKey: number;
  /** Eldeki atanabilir birim (süresi geçmiş kalem hariç). */
  available: number;
  /** Son pencerede tüketilen birim. */
  soldUnits: number;
  /** soldUnits / pencere (birim/gün). */
  dailyRate: number;
  /** available / dailyRate (gün); hız 0 ise null. */
  daysRemaining: number | null;
  /** Tahmini tükenme tarihi (YYYY-MM-DD); hız 0 ise null. */
  stockoutOn: string | null;
  supplierId: string | null;
  supplierName: string | null;
  /** Tedarikçinin ortalama teslim süresi (gün) — bilinmiyorsa null (uydurma YOK). */
  leadDays: number | null;
  /** Açık satın alma emirlerinde bekleyen ADET (anahtar). */
  openOrderKeys: number;
  /** Aynı miktarın BİRİM karşılığı (openOrderKeys × unitsPerKey). */
  openOrderUnits: number;
  /** dailyRate × (leadDays + emniyet) — birim; leadDays yoksa null. */
  reorderPointUnits: number | null;
  /** Önerilen birim (0'dan küçük olamaz); leadDays yoksa null. */
  suggestedUnits: number | null;
  /** Önerilen ADET (anahtar) = ceil(suggestedUnits / unitsPerKey); leadDays yoksa null. */
  suggestedKeys: number | null;
  /** Mevcut SABİT eşik (karşılaştırma için) — null ise uyarı kapalı. */
  lowStockThreshold: number | null;
  /** Sabit eşiğe göre "düşük stok" mu? (Bu raporun eşiğiyle çelişebilir — kasıtlı gösterilir.) */
  belowFixedThreshold: boolean;
  status: ReorderStatus;
}

export interface ReorderReport {
  generatedAt: string;
  /** Formülün girdileri — arayüz metni bu değerlerden yazılır (tek kaynak). */
  params: {
    windowDays: number;
    safetyDays: number;
    coverDays: number;
  };
  rows: ReorderRow[];
  counts: Record<ReorderStatus, number>;
  /** LIMIT'e takıldı mı (sessiz kırpma yasak). */
  truncated: boolean;
  excluded: {
    /** Stoksuz/ön sipariş ürünü (stok tutmaz). */
    stocklessProducts: number;
    /** Son pencerede satışı olmayan ürün (tükenme tahmini üretilemez). */
    noSalesProducts: number;
  };
}

interface RawReorderRow {
  product_id: string;
  sku: string;
  name: string;
  usage_mode: string;
  max_uses: number | null;
  low_stock_threshold: number | null;
  sold_units: number;
  available: number;
  open_qty_keys: number;
  supplier_id: string | null;
  supplier_name: string | null;
  avg_lead_days: string | number | null;
}

@Injectable()
export class ReorderService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async report(): Promise<ReorderReport> {
    const w = REORDER_WINDOW_DAYS;

    const [rows, excludedRows] = await Promise.all([
      rawRows<RawReorderRow>(
        this.db,
        sql`
          WITH sales AS (
            /* Son pencerede TÜKETİLEN birim. Yalnız AYAKTA atamalar (reports.velocity ile aynı
               küme) + iptal edilmemiş satırlar; iade/değişimde düşen atama satış sayılmaz.
               a.created_at FONKSİYONA SARILMAZ → assignments_created_idx kullanılır.
               DİKKAT: bu blok bir sql şablonunun İÇİNDE — ters tırnak KULLANMA. */
            SELECT ol.product_id AS product_id, coalesce(sum(a.units), 0)::int AS sold_units
            FROM assignments a
            JOIN order_lines ol ON ol.id = a.line_id
            WHERE a.created_at >= now() - make_interval(days => ${w}::int)
              AND a.status IN ('active', 'suspended', 'expired')
              AND ol.canceled = false
              AND ol.product_id IS NOT NULL
            GROUP BY ol.product_id
          ),
          stock AS (
            /* Atanabilir KAPASİTE — assign.ts'in notExpiredCond yüklemiyle BİREBİR aynı.
               (Süresi geçmiş kalem sayılırsa tükenme tahmini olduğundan uzun çıkar.) */
            SELECT li.product_id, coalesce(sum(li.max_uses - li.use_count), 0)::int AS available
            FROM license_items li
            WHERE li.status = 'available'
              AND (li.expires_at IS NULL OR li.expires_at > now())
            GROUP BY li.product_id
          ),
          open_po AS (
            /* Açık emirlerde bekleyen ADET — zaten yolda olanı tekrar sipariş etmemek için. */
            SELECT po.product_id,
                   coalesce(sum(greatest(po.qty_ordered - po.qty_received, 0)), 0)::int AS open_qty_keys
            FROM purchase_orders po
            WHERE po.status IN ('draft', 'ordered', 'partial')
            GROUP BY po.product_id
          ),
          last_supplier AS (
            /* Ürünün GÜNCEL tedarikçisi = en son teslim alınan partinin tedarikçisi.
               Zincir CostsService.wastage / SuppliersService.scorecard ile AYNI
               (parti doğrudan taşımıyorsa satın alma emrinden gelir) — iki farklı zincir
               aynı ürün için iki farklı tedarikçi gösterirdi. */
            SELECT DISTINCT ON (b.product_id)
              b.product_id,
              coalesce(b.supplier_id, po.supplier_id) AS supplier_id
            FROM batches b
            LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id
            WHERE coalesce(b.supplier_id, po.supplier_id) IS NOT NULL
            ORDER BY b.product_id, b.received_at DESC, b.id DESC
          ),
          /* CTE adı bilerek "supplier_lead": çıplak "lead" bir pencere fonksiyonu adıyla
             çakışıyormuş gibi okunur ve ileride şaşırtır. */
          supplier_lead AS (
            /* Tedarikçi başına ortalama teslim süresi (gün). YÜKLEM SuppliersService.scorecard
               ile BİREBİR: yalnız KAPANMIŞ (status='received') ve iki tarihi de dolu emirler.
               Stok Girişi'nin açtığı otomatik emirlerde ordered_at bilerek NULL → sayılmaz. */
            SELECT supplier_id,
                   avg(extract(epoch FROM (received_at - ordered_at)) / 86400.0) AS avg_lead_days
            FROM purchase_orders
            WHERE received_at IS NOT NULL
              AND ordered_at IS NOT NULL
              AND status = 'received'
            GROUP BY supplier_id
          )
          SELECT
            p.id AS product_id,
            p.sku AS sku,
            p.name AS name,
            p.usage_mode::text AS usage_mode,
            p.max_uses AS max_uses,
            p.low_stock_threshold AS low_stock_threshold,
            s.sold_units AS sold_units,
            coalesce(st.available, 0) AS available,
            coalesce(op.open_qty_keys, 0) AS open_qty_keys,
            ls.supplier_id AS supplier_id,
            sup.name AS supplier_name,
            l.avg_lead_days AS avg_lead_days
          FROM products p
          /* INNER JOIN: yalnız pencerede satışı OLAN ürünler — hızsız üründe tükenme tarihi
             türetilemez (0'a bölme). Elenenlerin sayısı excluded.noSalesProducts alanında. */
          JOIN sales s ON s.product_id = p.id
          LEFT JOIN stock st ON st.product_id = p.id
          LEFT JOIN open_po op ON op.product_id = p.id
          LEFT JOIN last_supplier ls ON ls.product_id = p.id
          LEFT JOIN suppliers sup ON sup.id = ls.supplier_id
          LEFT JOIN supplier_lead l ON l.supplier_id = ls.supplier_id
          WHERE p.stockless = false
          /* En acil önce: kalan gün (stok / günlük hız) artan. TIE-BREAK sku ZORUNLU —
             LIMIT'li her sıralamada pencere sınırı aksi hâlde keyfi olur. */
          ORDER BY
            (coalesce(st.available, 0)::numeric * ${w}::numeric / nullif(s.sold_units, 0)::numeric)
              ASC NULLS LAST,
            p.sku ASC
          LIMIT ${REORDER_ROW_LIMIT + 1};
        `,
      ),
      rawRows<{ stockless_products: number; no_sales_products: number }>(
        this.db,
        sql`
          SELECT
            count(*) FILTER (WHERE p.stockless = true)::int AS stockless_products,
            count(*) FILTER (
              WHERE p.stockless = false
                AND NOT EXISTS (
                  SELECT 1
                  FROM assignments a
                  JOIN order_lines ol ON ol.id = a.line_id
                  WHERE ol.product_id = p.id
                    AND ol.canceled = false
                    AND a.created_at >= now() - make_interval(days => ${w}::int)
                    AND a.status IN ('active', 'suspended', 'expired')
                )
            )::int AS no_sales_products
          FROM products p;
        `,
      ),
    ]);

    const truncated = rows.length > REORDER_ROW_LIMIT;
    const nowMs = Date.now();
    const counts: Record<ReorderStatus, number> = {
      out: 0,
      order_now: 0,
      watch: 0,
      ok: 0,
      unknown_lead: 0,
    };

    const mapped: ReorderRow[] = rows.slice(0, REORDER_ROW_LIMIT).map((r) => {
      const usageMode = r.usage_mode === 'multi' ? 'multi' : 'single';
      // Anahtar → birim çevirisi. multi'de max_uses null kalmışsa 1'e düşülür (veri
      // bozuksa öneriyi ŞİŞİRMEK yerine muhafazakâr davran).
      const unitsPerKey = usageMode === 'multi' ? Math.max(1, Number(r.max_uses ?? 1)) : 1;
      const available = Number(r.available ?? 0);
      const soldUnits = Number(r.sold_units ?? 0);
      const dailyRate = soldUnits / REORDER_WINDOW_DAYS;
      const daysRemaining = dailyRate > 0 ? available / dailyRate : null;
      const stockoutOn =
        daysRemaining == null
          ? null
          : new Date(nowMs + daysRemaining * 86_400_000).toISOString().slice(0, 10);

      const leadRaw = r.avg_lead_days;
      const leadDays =
        leadRaw == null || !Number.isFinite(Number(leadRaw))
          ? null
          : Math.round(Number(leadRaw) * 10) / 10;

      const openOrderKeys = Number(r.open_qty_keys ?? 0);
      const openOrderUnits = openOrderKeys * unitsPerKey;

      let reorderPointUnits: number | null = null;
      let suggestedUnits: number | null = null;
      let suggestedKeys: number | null = null;
      let status: ReorderStatus = 'unknown_lead';

      if (leadDays != null) {
        reorderPointUnits = Math.ceil(dailyRate * (leadDays + SAFETY_DAYS));
        const targetUnits = Math.ceil(
          dailyRate * (leadDays + SAFETY_DAYS + TARGET_COVER_DAYS),
        );
        suggestedUnits = Math.max(0, targetUnits - available - openOrderUnits);
        suggestedKeys = Math.ceil(suggestedUnits / unitsPerKey);

        if (available <= 0) status = 'out';
        else if (available <= reorderPointUnits) status = 'order_now';
        else if (
          daysRemaining != null &&
          daysRemaining <= leadDays + SAFETY_DAYS + TARGET_COVER_DAYS
        ) {
          status = 'watch';
        } else status = 'ok';
      }

      counts[status] += 1;

      const lowStockThreshold = r.low_stock_threshold == null ? null : Number(r.low_stock_threshold);
      return {
        productId: r.product_id,
        sku: r.sku,
        name: r.name,
        usageMode,
        unitsPerKey,
        available,
        soldUnits,
        dailyRate: Math.round(dailyRate * 100) / 100,
        daysRemaining: daysRemaining == null ? null : Math.round(daysRemaining * 10) / 10,
        stockoutOn,
        supplierId: r.supplier_id,
        supplierName: r.supplier_name,
        leadDays,
        openOrderKeys,
        openOrderUnits,
        reorderPointUnits,
        suggestedUnits,
        suggestedKeys,
        lowStockThreshold,
        belowFixedThreshold: lowStockThreshold != null && available <= lowStockThreshold,
        status,
      };
    });

    const ex = excludedRows[0];
    return {
      generatedAt: new Date().toISOString(),
      params: {
        windowDays: REORDER_WINDOW_DAYS,
        safetyDays: SAFETY_DAYS,
        coverDays: TARGET_COVER_DAYS,
      },
      rows: mapped,
      counts,
      truncated,
      excluded: {
        stocklessProducts: Number(ex?.stockless_products ?? 0),
        noSalesProducts: Number(ex?.no_sales_products ?? 0),
      },
    };
  }
}
