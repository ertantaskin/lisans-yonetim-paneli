import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';

/**
 * TESLİMAT SÜRESİ (SLA) RAPORU — "sipariş düştükten kaç dakika sonra müşteri anahtarı aldı?"
 *
 * NEDEN VAR: `/pending` yalnız ANLIK kuyruğu gösterir; "dün ortalama kaç dakikada teslim ettik,
 * hangi mağazada/üründe bekleme birikiyor" sorusunun cevabı hiçbir ekranda yoktu.
 *
 * ── ÖLÇÜM (tek tanım) ────────────────────────────────────────────────────────────────────
 *   bekleme = (siparişin SON teslim anı) − (siparişin panele düştüğü an)
 *
 *   • Sipariş anı  : `orders.created_at`      (indexli: orders_created_idx / orders_site_created_idx)
 *   • Teslim anı   : `assignments.created_at` (indexli: assignments_created_idx / assignments_line_idx)
 *     `delivered_at` DEĞİL — ve bu artık SEMANTİK bir tercihtir, teknik zorunluluk değil:
 *     kolon migration 0043'ten beri indekslidir (`assignments_delivered_at_idx`, kısmi:
 *     `WHERE delivered_at IS NOT NULL`), yani eski gerekçe ("nullable ve INDEKSSİZ, pencere
 *     taraması index'ten karşılanamaz") GEÇERSİZDİR. `created_at` yine de tercih edilir:
 *     NOT NULL'dur (nullable kolonda ölçülemeyen satır SESSİZCE kohorttan düşerdi) ve atama
 *     satırı yazılırken aynı anda doldurulduğu için taşıdığı zaman bilgisi zaten aynıdır.
 *     Kısmi indeks de yalnız teslim edilmiş atamaları kapsar; SLA ise "hâlâ açık" satırları
 *     (stillOpen) görmek zorundadır.
 *
 * ── "ANINDA" vs "BEKLEDİ" AYRIMI — EŞİK DEĞİL, YAPISAL ────────────────────────────────────
 * `createOrder` siparişi VE atamalarını TEK transaction'da yazar; iki tablonun `created_at`
 * varsayılanı da `now()` (= transaction BAŞLANGIÇ damgası) olduğundan anında teslim edilen
 * siparişte fark TAM OLARAK 0'dır. Stok bekleyip sonradan `autoComplete`/`completeLine` ile
 * dolan satır AYRI bir transaction'da yazılır → fark her zaman > 0. Yani ayrım uydurma bir
 * eşiğe (ör. "60 sn altı anındadır") değil, veri modelinin kendisine dayanır:
 *   bekleme <= 0  ⇒ anında   ·   bekleme > 0 ⇒ stok/onay bekledi
 * Ortalama TEK BAŞINA yanıltıcıdır (tek bir 3 günlük stok beklemesi günün ortalamasını
 * uçurur) → her kova için medyan (p50) ve p95 de döner.
 *
 * ── HESABA KATILMAYANLAR (bu projenin bilinen tuzakları) ──────────────────────────────────
 *  1. `orders.held_for_review = true` (İnceleme Kuyruğu): teslimat bilerek İNSAN kararını
 *     bekler; SLA'ya katılırsa operatörün onay gecikmesi "sistem yavaş" gibi okunur.
 *  2. `order_lines.canceled = true` (iade/iptal terminal işareti): iptal satırı hiç teslim
 *     edilmeyeceği için sonsuza kadar "açık" sayılır ve kuyruğu şişirirdi.
 *  3. `remote_line_id LIKE 'bonus:%'` (operatörün elle eklediği hediye satırı): mağazadan
 *     gelen bir talep DEĞİLDİR ve sipariş tarihinden günler sonra eklenir → bekleme uydurur.
 *  4. DEĞİŞİMLE verilen taze anahtar (`assignment_history.assignment_id` = o atama): ilk
 *     teslimat çoktan yapılmıştır; değişim tarihi "teslim süresi" sayılırsa p95 çöker.
 *     `assignment_history_assignment_idx` sayesinde NOT EXISTS kontrolü indexlidir.
 *  Üçü de yanıtta `excluded` altında SAYIYLA raporlanır (sessiz eleme yok). Buna ek olarak
 *  ölçülebilir satırı HİÇ kalmayan sipariş sayısı da (2+3'ün SİPARİŞ karşılığı)
 *  `excluded.ordersWithoutMeasurableLines` ile döner — o siparişler ne `measured`'a ne
 *  `stillOpen`'a girer, yani sayısı verilmezse raporda sessizce yok olurlar.
 *
 * ── MAK / ÇOK KULLANIMLI ÜRÜNLER ─────────────────────────────────────────────────────────
 * "Sipariş tamamen teslim edildi mi?" sorusu BİRİM uzayında sorulur: hedef = `qty −
 * canceled_units` (`orders/fill-target.ts` ile AYNI tanım), teslim edilen = `fulfilled_qty`.
 * MAK'ta tek bir atama `units` > 1 tüketebilir; adet SAYMAK yerine birim defterine bakmak
 * bu yüzden şart (1 anahtar × 500 kullanım = 500 birim).
 *
 * ── KOHORT DÜRÜSTLÜĞÜ ────────────────────────────────────────────────────────────────────
 * Gün kırılımı SİPARİŞİN düştüğü güne göredir (kohort). O gün açılıp HÂLÂ tamamlanmamış
 * siparişler ortalamaya giremez — bu bir hayatta-kalma yanlılığıdır ve gizlenirse "dün her
 * şey hızlıydı" yalanı üretir. Bu yüzden her satır ayrıca `stillOpen` taşır.
 *
 * Salt-okunur: hiçbir yazma/yan etki yok.
 */

/** Bir kovanın (anında/bekleyen/tümü) süre istatistiği — saniye cinsinden. */
export interface SlaStats {
  /** Ortalama (saniye) — tek başına yanıltıcı, p50/p95 ile birlikte okunmalı. */
  avgSeconds: number | null;
  /** Medyan (p50) — "tipik" sipariş. */
  p50Seconds: number | null;
  /** p95 — en yavaş %5'in eşiği (SLA vaadi bunun üzerinden verilir). */
  p95Seconds: number | null;
  /** En kötü tekil değer. */
  maxSeconds: number | null;
}

/** Ölçülen bir küme (gün / mağaza / ürün) için sayaçlar + iki kovanın istatistiği. */
export interface SlaBucket {
  /** Ölçüme giren (tamamı teslim edilmiş) sipariş/satır sayısı. */
  measured: number;
  /** Bekleme = 0 → aynı transaction'da teslim edildi. */
  instant: number;
  /** Bekleme > 0 → stok/tamamlama bekledi. */
  waited: number;
  /** Kohortta HÂLÂ tamamlanmamış (ölçüme giremeyen) sipariş/satır. */
  stillOpen: number;
  /** YALNIZ bekleyenlerin istatistiği (asıl sinyal). */
  waitedStats: SlaStats;
  /** Anında teslimler DAHİL tüm kümenin istatistiği (karşılaştırma için). */
  overallStats: SlaStats;
}

export interface SlaDailyRow extends SlaBucket {
  /** Yerel gün (YYYY-MM-DD) — sunucu/DB TimeZone'una göre (Europe/Istanbul). */
  day: string;
}

export interface SlaBreakdownRow extends SlaBucket {
  id: string;
  /** Mağaza alan adı ya da ürün adı (ham kimlik kullanıcıya çıkmaz). */
  label: string;
  /** Ürün kırılımında SKU; mağaza kırılımında null. */
  sku: string | null;
}

export interface SlaReport {
  generatedAt: string;
  /** Pencere uzunluğu (gün) — bugün dâhil. */
  windowDays: number;
  /** Pencere başlangıcı (yerel gün başı) / bitişi (şimdi) — ISO. */
  from: string;
  to: string;
  /** Tüm pencerenin sipariş bazlı özeti. */
  totals: SlaBucket;
  /** Sipariş bazlı gün serisi (kohort: siparişin düştüğü gün). */
  daily: SlaDailyRow[];
  /** Mağaza kırılımı (sipariş bazlı) — en çok bekleme biriken önce. */
  bySite: SlaBreakdownRow[];
  /** Ürün kırılımı (SATIR bazlı — bir sipariş birden çok ürün taşıyabilir). */
  byProduct: SlaBreakdownRow[];
  /** LIMIT'e takılan kırılım var mı (sessiz kırpma yasak). */
  truncated: { bySite: boolean; byProduct: boolean };
  /** Bilerek hesap dışı bırakılanlar — sayıyla. */
  excluded: {
    heldOrders: number;
    canceledLines: number;
    bonusLines: number;
    /**
     * ÖLÇÜLEBİLİR SATIRI HİÇ OLMAYAN sipariş (denetim bulgusu R11): `order_wait` CTE'si
     * `line_delivery` ile INNER JOIN yaptığı için satırı olmayan ya da TÜM satırları
     * iptal/bonus olan sipariş `measured`'a da `stillOpen`'a da GİRMEZ — sessizce yok
     * olurdu. Eleme SATIR sayısıyla (canceledLines/bonusLines) raporlanıyordu ama
     * SİPARİŞ olarak değil; "dün 40 sipariş vardı, raporda 37 var" farkı açıklanamıyordu.
     * Bu sayaç o farkı görünür kılar. (Bunlar "açık" DEĞİLDİR: tamamı iptal edilmiş bir
     * sipariş bekleyen iş değildir → `stillOpen`'a eklemek de yanlış olurdu.)
     */
    ordersWithoutMeasurableLines: number;
  };
}

/** Ham SQL agregat satırı (tüm kırılımlar aynı kolon setini döndürür). */
interface RawBucket {
  measured: number;
  instant: number;
  waited: number;
  still_open: number;
  w_avg: string | number | null;
  w_p50: string | number | null;
  w_p95: string | number | null;
  w_max: string | number | null;
  a_avg: string | number | null;
  a_p50: string | number | null;
  a_p95: string | number | null;
  a_max: string | number | null;
}

/**
 * Her kırılımda BİREBİR aynı agregat kolonları — tek metinde tutulur ki gün/mağaza/ürün
 * kırılımları asla farklı tanımlara kaymasın (bu projede "aynı kavramın iki yüklemi" sınıfı
 * hata defalarca yaşandı). Girdi içermez → `sql.raw` güvenli.
 *
 * NOT: `percentile_cont` bir ORDERED-SET agregatıdır ve `FILTER` alır; NULL beklemeleri
 * (ölçüme girmeyen satırlar) filtreyle AÇIKÇA elenir — sürücü/sürüm davranışına bırakılmaz.
 */
const STAT_COLS = sql.raw(`
    count(*) FILTER (WHERE wait_seconds IS NOT NULL)::int AS measured,
    count(*) FILTER (WHERE wait_seconds IS NOT NULL AND wait_seconds <= 0)::int AS instant,
    count(*) FILTER (WHERE wait_seconds > 0)::int AS waited,
    count(*) FILTER (WHERE is_open)::int AS still_open,
    avg(wait_seconds) FILTER (WHERE wait_seconds > 0) AS w_avg,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_seconds) FILTER (WHERE wait_seconds > 0) AS w_p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY wait_seconds) FILTER (WHERE wait_seconds > 0) AS w_p95,
    max(wait_seconds) FILTER (WHERE wait_seconds > 0) AS w_max,
    avg(wait_seconds) FILTER (WHERE wait_seconds IS NOT NULL) AS a_avg,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_seconds) FILTER (WHERE wait_seconds IS NOT NULL) AS a_p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY wait_seconds) FILTER (WHERE wait_seconds IS NOT NULL) AS a_p95,
    max(wait_seconds) FILTER (WHERE wait_seconds IS NOT NULL) AS a_max`);

@Injectable()
export class SlaService {
  /** Varsayılan pencere (gün). */
  static readonly DEFAULT_DAYS = 30;
  /** Kabul edilen en kısa/uzun pencere — üst sınır tarama maliyetini sabitler. */
  static readonly MIN_DAYS = 1;
  static readonly MAX_DAYS = 90;
  /** Kırılım tavanları (tavan+1 çekilir → `truncated` HAM satır sayısından türer). */
  static readonly SITE_LIMIT = 50;
  static readonly PRODUCT_LIMIT = 50;

  constructor(@Inject(DB) private readonly db: Database) {}

  /** `days` parametresini sınırlara oturtur (geçersiz/eksik → varsayılan). */
  static normalizeDays(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isFinite(n)) return SlaService.DEFAULT_DAYS;
    const i = Math.floor(n);
    if (i < SlaService.MIN_DAYS) return SlaService.MIN_DAYS;
    if (i > SlaService.MAX_DAYS) return SlaService.MAX_DAYS;
    return i;
  }

  /**
   * Tüm kırılımların paylaştığı CTE zinciri. TEK yerde tanımlı olması şart: gün/mağaza/ürün
   * sorguları farklı bir "teslim edildi" yüklemi kullanırsa aynı ekranda çelişen sayılar çıkar.
   *
   * PENCERE İNDEX DOSTU: `o.created_at` FONKSİYONA SARILMAZ (`date_trunc(created_at)` yazsaydık
   * `orders_created_idx` kullanılamaz, tüm tablo taranırdı). Gün etiketi yalnız SELECT/GROUP BY
   * tarafında `::date` ile üretilir.
   */
  private scopeCte(days: number): SQL {
    return sql`
      /* Pencere sınırları TEK yerde: yerel gün başı (bugün dâhil "days" gün) → şimdi.
         DİKKAT: bu blok bir sql şablonunun İÇİNDE — ters tırnak KULLANMA (şablonu erken kapatır). */
      win AS (
        SELECT
          date_trunc('day', now()) - make_interval(days => ${days - 1}::int) AS from_ts,
          now() AS to_ts
      ),
      /* Ölçüme giren siparişler. held_for_review HARİÇ (insan kararı bekliyor). */
      scoped_orders AS (
        SELECT o.id, o.site_id, o.created_at
        FROM orders o, win
        WHERE o.created_at >= win.from_ts
          AND o.created_at < win.to_ts
          AND o.held_for_review = false
      ),
      /* Ölçüme giren satırlar: iptal EDİLMEMİŞ ve BONUS olmayan (mağazadan gelen gerçek talep). */
      scoped_lines AS (
        SELECT
          ol.id AS line_id,
          ol.order_id,
          ol.product_id,
          /* Doldurma hedefi = qty − canceled_units (orders/fill-target.ts ile AYNI tanım). */
          greatest(ol.qty - ol.canceled_units, 0) AS target,
          ol.fulfilled_qty
        FROM order_lines ol
        JOIN scoped_orders so ON so.id = ol.order_id
        WHERE ol.canceled = false
          AND ol.remote_line_id NOT LIKE 'bonus:%'
      ),
      /* Satır başına: hedefe ulaştı mı + SON teslim anı (değişimle verilen anahtar HARİÇ). */
      line_delivery AS (
        SELECT
          sl.line_id,
          sl.order_id,
          sl.product_id,
          (sl.fulfilled_qty >= sl.target) AS complete,
          (
            SELECT max(a.created_at)
            FROM assignments a
            WHERE a.line_id = sl.line_id
              AND NOT EXISTS (
                SELECT 1 FROM assignment_history ah WHERE ah.assignment_id = a.id
              )
          ) AS last_delivery_at
        FROM scoped_lines sl
      ),
      /* Sipariş bazlı: tüm satırları tamamlandıysa ölçülebilir; bekleme = son teslim − sipariş.
         JOIN bilerek INNER: ölçülebilir SATIRI olmayan sipariş (satırsız / tüm satırları
         iptal ya da bonus) bir "bekleme" üretemez; ortalamaya 0 ya da NULL olarak sokmak
         raporu bozardı. Ama SESSİZ kaybolmasın diye SAYISI ayrıca raporlanır
         (excluded.ordersWithoutMeasurableLines — aşağıdaki excluded_counts).
         DİKKAT: bu blok bir sql şablonunun İÇİNDE — ters tırnak KULLANMA. */
      order_wait AS (
        SELECT
          so.id AS order_id,
          so.site_id,
          so.created_at,
          NOT bool_and(ld.complete) AS is_open,
          CASE
            WHEN bool_and(ld.complete) AND max(ld.last_delivery_at) IS NOT NULL
              THEN extract(epoch FROM (max(ld.last_delivery_at) - so.created_at))
          END AS wait_seconds
        FROM scoped_orders so
        JOIN line_delivery ld ON ld.order_id = so.id
        GROUP BY so.id, so.site_id, so.created_at
      ),
      /* Satır bazlı (ürün kırılımı): bir sipariş birden çok ürün taşıyabilir → satırdan ölçülür.
         Eşlemesiz satır (product_id NULL) ürün kırılımına giremez; o boşluk /mappings ekranının işi. */
      line_wait AS (
        SELECT
          ld.product_id,
          NOT ld.complete AS is_open,
          CASE
            WHEN ld.complete AND ld.last_delivery_at IS NOT NULL
              THEN extract(epoch FROM (ld.last_delivery_at - so.created_at))
          END AS wait_seconds
        FROM line_delivery ld
        JOIN scoped_orders so ON so.id = ld.order_id
        WHERE ld.product_id IS NOT NULL
      )`;
  }

  /** Ham sayısal alanı (numeric → string gelebilir) saniyeye normalize eder. */
  private static num(v: string | number | null): number | null {
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    // Saniyeyi 1 ondalığa yuvarla — mikro saniye gürültüsü rapora sızmasın.
    return Math.round(n * 10) / 10;
  }

  private static toBucket(r: RawBucket | undefined): SlaBucket {
    return {
      measured: Number(r?.measured ?? 0),
      instant: Number(r?.instant ?? 0),
      waited: Number(r?.waited ?? 0),
      stillOpen: Number(r?.still_open ?? 0),
      waitedStats: {
        avgSeconds: SlaService.num(r?.w_avg ?? null),
        p50Seconds: SlaService.num(r?.w_p50 ?? null),
        p95Seconds: SlaService.num(r?.w_p95 ?? null),
        maxSeconds: SlaService.num(r?.w_max ?? null),
      },
      overallStats: {
        avgSeconds: SlaService.num(r?.a_avg ?? null),
        p50Seconds: SlaService.num(r?.a_p50 ?? null),
        p95Seconds: SlaService.num(r?.a_p95 ?? null),
        maxSeconds: SlaService.num(r?.a_max ?? null),
      },
    };
  }

  /** Teslimat süresi raporu. `days`: 1..90 (varsayılan 30, bugün dâhil). */
  async report(daysRaw?: unknown): Promise<SlaReport> {
    const days = SlaService.normalizeDays(daysRaw ?? SlaService.DEFAULT_DAYS);
    const cte = this.scopeCte(days);

    const [totalsRows, dailyRows, siteRows, productRows] = await Promise.all([
      // (1) Toplam + pencere sınırları + hariç tutulanların SAYISI (dürüst eleme).
      rawRows<
        RawBucket & {
          from_ts: unknown;
          to_ts: unknown;
          held_orders: number;
          canceled_lines: number;
          bonus_lines: number;
          unmeasurable_orders: number;
        }
      >(
        this.db,
        sql`
          WITH ${cte},
          excluded_counts AS (
            SELECT
              (
                SELECT count(*)::int FROM orders o, win
                WHERE o.created_at >= win.from_ts AND o.created_at < win.to_ts
                  AND o.held_for_review = true
              ) AS held_orders,
              (
                SELECT count(*)::int FROM order_lines ol
                JOIN orders o ON o.id = ol.order_id, win
                WHERE o.created_at >= win.from_ts AND o.created_at < win.to_ts
                  AND ol.canceled = true
              ) AS canceled_lines,
              (
                SELECT count(*)::int FROM order_lines ol
                JOIN orders o ON o.id = ol.order_id, win
                WHERE o.created_at >= win.from_ts AND o.created_at < win.to_ts
                  AND ol.remote_line_id LIKE 'bonus:%'
              ) AS bonus_lines,
              (
                /* Kapsamdaki ama ÖLÇÜLEBİLİR SATIRI OLMAYAN sipariş — order_wait'in INNER
                   JOIN'inden düşenlerin TAM KARŞILIĞI (aynı scoped_lines yüklemi üzerinden
                   NOT EXISTS): satırsız sipariş ya da tüm satırları iptal/bonus olanlar. */
                SELECT count(*)::int FROM scoped_orders so
                WHERE NOT EXISTS (SELECT 1 FROM scoped_lines sl WHERE sl.order_id = so.id)
              ) AS unmeasurable_orders
          )
          SELECT
            ${STAT_COLS},
            (SELECT from_ts FROM win) AS from_ts,
            (SELECT to_ts FROM win) AS to_ts,
            (SELECT held_orders FROM excluded_counts) AS held_orders,
            (SELECT canceled_lines FROM excluded_counts) AS canceled_lines,
            (SELECT bonus_lines FROM excluded_counts) AS bonus_lines,
            (SELECT unmeasurable_orders FROM excluded_counts) AS unmeasurable_orders
          FROM order_wait;
        `,
      ),

      // (2) Gün serisi (kohort: siparişin düştüğü yerel gün).
      rawRows<RawBucket & { day: string }>(
        this.db,
        sql`
          WITH ${cte}
          SELECT
            to_char(created_at::date, 'YYYY-MM-DD') AS day,
            ${STAT_COLS}
          FROM order_wait
          GROUP BY created_at::date
          ORDER BY created_at::date ASC;
        `,
      ),

      // (3) Mağaza kırılımı — bekleme biriken önce. TAVAN+1 çekilir (kırpma dürüstlüğü).
      rawRows<RawBucket & { id: string; label: string }>(
        this.db,
        sql`
          WITH ${cte}
          SELECT
            s.id AS id,
            s.domain AS label,
            ${STAT_COLS}
          FROM order_wait ow
          JOIN sites s ON s.id = ow.site_id
          GROUP BY s.id, s.domain
          ORDER BY
            count(*) FILTER (WHERE is_open) DESC,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY wait_seconds) FILTER (WHERE wait_seconds > 0) DESC NULLS LAST,
            count(*) FILTER (WHERE wait_seconds > 0) DESC,
            s.domain ASC,
            s.id ASC
          LIMIT ${SlaService.SITE_LIMIT + 1};
        `,
      ),

      // (4) Ürün kırılımı (SATIR bazlı) — aynı sıralama dili.
      rawRows<RawBucket & { id: string; label: string; sku: string }>(
        this.db,
        sql`
          WITH ${cte}
          SELECT
            p.id AS id,
            p.name AS label,
            p.sku AS sku,
            ${STAT_COLS}
          FROM line_wait lw
          JOIN products p ON p.id = lw.product_id
          GROUP BY p.id, p.name, p.sku
          ORDER BY
            count(*) FILTER (WHERE is_open) DESC,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY wait_seconds) FILTER (WHERE wait_seconds > 0) DESC NULLS LAST,
            count(*) FILTER (WHERE wait_seconds > 0) DESC,
            p.sku ASC,
            p.id ASC
          LIMIT ${SlaService.PRODUCT_LIMIT + 1};
        `,
      ),
    ]);

    const t = totalsRows[0];
    const toIso = (v: unknown): string =>
      v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

    // Sinyal HAM satır sayısından türer; tespit için çekilen fazladan satır YANITA GİRMEZ.
    const siteTruncated = siteRows.length > SlaService.SITE_LIMIT;
    const productTruncated = productRows.length > SlaService.PRODUCT_LIMIT;

    return {
      generatedAt: new Date().toISOString(),
      windowDays: days,
      from: t ? toIso(t.from_ts) : new Date().toISOString(),
      to: t ? toIso(t.to_ts) : new Date().toISOString(),
      totals: SlaService.toBucket(t),
      daily: dailyRows.map((r) => ({ day: r.day, ...SlaService.toBucket(r) })),
      bySite: siteRows.slice(0, SlaService.SITE_LIMIT).map((r) => ({
        id: r.id,
        label: r.label,
        sku: null,
        ...SlaService.toBucket(r),
      })),
      byProduct: productRows.slice(0, SlaService.PRODUCT_LIMIT).map((r) => ({
        id: r.id,
        label: r.label,
        sku: r.sku,
        ...SlaService.toBucket(r),
      })),
      truncated: { bySite: siteTruncated, byProduct: productTruncated },
      excluded: {
        heldOrders: Number(t?.held_orders ?? 0),
        canceledLines: Number(t?.canceled_lines ?? 0),
        bonusLines: Number(t?.bonus_lines ?? 0),
        ordersWithoutMeasurableLines: Number(t?.unmeasurable_orders ?? 0),
      },
    };
  }
}
