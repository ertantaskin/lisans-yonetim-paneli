import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { customers } from '../db/schema/customers';

/** Liste satırı — sipariş/atama/değişim sayıları anlık türetilir (§13). */
export interface CustomerListRow {
  email: string;
  orderCount: number;
  assignmentCount: number;
  replacementCount: number;
  replacementRate: number;
  tags: string[];
  /** Müşterinin sipariş verdiği site alan adları (site süzgeci uygulandıysa tek eleman). */
  sites: string[];
  firstOrderAt: string | null;
  lastOrderAt: string | null;
}

/**
 * Mağaza (site) başına müşteri özeti — `/customers` ekranının GİRİŞ seviyesi (§13).
 *
 * NEDEN: müşteriler e-posta bazlı GLOBAL kayıtlardır, ama operatör "hangi mağazanın
 * müşterisi" diye düşünür; çok siteli kurulumda tek düz liste karışıyordu (kullanıcı
 * geri bildirimi). Hiyerarşi yalnız SUNUM katmanındadır — veri modeli değişmez.
 *
 * DİKKAT (ekranda da yazar): aynı e-posta iki mağazadan alışveriş yaptıysa HER İKİ
 * mağazada da sayılır → site sayaçlarının toplamı global müşteri sayısından BÜYÜK olabilir.
 */
export interface CustomerSiteSummaryRow {
  siteId: string;
  domain: string;
  type: string;
  customerCount: number;
  orderCount: number;
  lastOrderAt: string | null;
}

/** Müşteri detayı — kalıcı meta (tags/notes) + türetilmiş istatistik + geçmiş. */
export interface CustomerDetail {
  email: string;
  tags: string[];
  notes: string | null;
  stats: {
    orderCount: number;
    assignmentCount: number;
    replacementCount: number;
    replacementRate: number;
  };
  /**
   * Sipariş geçmişi. `siteDomain`: liste ekranındaki "Siteler" kolonunun detaydaki karşılığı —
   * aynı müşteri iki mağazadan alışveriş yaptığında hangi satırın hangi mağazaya ait olduğu
   * (ve iki mağazadaki AYNI numaralı siparişler) ancak böyle ayırt edilir. Site silinmişse null.
   */
  orders: Array<{
    id: string;
    remoteOrderId: string;
    status: string;
    createdAt: string;
    siteDomain: string | null;
  }>;
  /**
   * Değişim/destek talepleri. `orderId` + `remoteOrderId`: talebin hangi siparişe ait olduğunu
   * gösterir ve satırı siparişe TIKLANABİLİR yapar (operatör /support'ta metinle aramasın).
   */
  replacements: Array<{
    id: string;
    status: string;
    reason: string;
    createdAt: string;
    orderId: string | null;
    remoteOrderId: string | null;
    siteDomain: string | null;
  }>;
}

/**
 * replacementRate = onaylı değişim / GREATEST(atama, 1) — sıfıra bölme yok.
 * 4 haneye yuvarlanır (yüzde gösterimi tüketicide yapılır).
 */
function rate(replacementCount: number, assignmentCount: number): number {
  return Math.round((replacementCount / Math.max(assignmentCount, 1)) * 10000) / 10000;
}

/**
 * Müşteri listesi tavanı. İstemci-taraflı arama korunsun diye cömert tutulur; aşılırsa
 * SESSİZ kırpma YOK — `truncated` ile raporlanır (bkz. `list` içindeki LIMIT notu).
 */
const CUSTOMER_LIST_LIMIT = 2000;

/**
 * `siteSummary` önbellek süresi. dashboard.service'teki COUNTER_CACHE_TTL_MS ile AYNI
 * değer (60 sn) ve AYNI gerekçe: bu sayaçlar SUNUM içindir — teslimat/atama kararları
 * bunlara DAYANMAZ, dolayısıyla ≤60 sn bayatlık kabul edilebilir.
 *
 * NEDEN GEREKLİ: `/customers` giriş ekranı her açılışta orders tablosunun TAMAMINI tarayıp
 * site başına COUNT(DISTINCT lower(email)) hesaplıyordu (grup agregasyonu, indeksle
 * karşılanamaz). Ekran her gezinmede yeniden çağrılır → sipariş hacmi büyüdükçe maliyet
 * doğrusal artar.
 *
 * NEDEN KOPYA DESEN (dashboard'daki `counterCached` yeniden KULLANILMADI): o yardımcı
 * DashboardService'in PRIVATE metodu ve yalnız `number` döndürür; buradaki değer bir SATIR
 * DİZİSİdir. Ortak bir yardımcıya çıkarmak dashboard.service.ts + modül bağlantılarını
 * değiştirmeyi gerektirirdi (bu partide o dosyalar başka işçilerde). Desen birebir aynı
 * tutuldu: TTL + `inflight` ile sürü-etkisi (thundering herd) koruması.
 */
const SITE_SUMMARY_CACHE_TTL_MS = 60_000;

/** TTL'li tek-uçuş önbellek yuvası (dashboard.service'teki CounterCacheSlot ile aynı şekil). */
interface SiteSummaryCacheSlot {
  value: CustomerSiteSummaryRow[] | null;
  at: number;
  inflight: Promise<CustomerSiteSummaryRow[]> | null;
}

/**
 * Müşteri servisi (§13). Sipariş/atama sayıları orders/assignments üzerinden anlık
 * hesaplanır; replacement sayıları RAW SQL ile replacement_requests'ten okunur
 * (drizzle şema bağımlılığı YOK — tablo migration sonrası var). e-posta lowercase kanonik.
 */
@Injectable()
export class CustomersService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * `siteSummary` önbellek yuvası. Servis singleton olduğu için alan süreç ömrü boyunca
   * yaşar; kalıcılık/invalidasyon YOKTUR (TTL yeter — bkz. SITE_SUMMARY_CACHE_TTL_MS).
   */
  private siteSummarySlot: SiteSummaryCacheSlot = { value: null, at: 0, inflight: null };

  /**
   * Müşteri listesi — e-posta bazlı toplulaştırma; search → e-posta ILIKE.
   * `siteId` verilirse SADECE o siteden sipariş vermiş müşteriler döner ve sipariş/atama/
   * değişim sayıları O SİTEYE göre kapsanır (site → müşteri hiyerarşisi, §13). Her satıra
   * müşterinin sipariş verdiği site alan adları (`sites`) eklenir → global görünümde
   * hangi site(ler) olduğu bir bakışta görünür.
   */
  /**
   * Mağaza başına müşteri/sipariş özeti — `/customers` giriş ekranı.
   *
   * Siteler LEFT JOIN'lenir: HENÜZ SİPARİŞİ OLMAYAN mağaza da listede kalır (0 müşteri).
   * Aksi halde yeni bağlanmış bir mağaza ekranda hiç görünmez ve operatör "bağlanmadı mı?"
   * diye sorar — sıfır, yokluk değil bilgidir.
   *
   * PERF: tek geçiş, site başına grup (orders(site_id, created_at) indeksi mevcut).
   * Sayaçlar anlık türetilir — müşteri sayısı ayrı bir tabloda TUTULMAZ (§13: müşteri
   * kaydı yalnız etiket/not taşır, sayılar siparişten okunur → tek doğruluk kaynağı).
   *
   * ÖNBELLEKLİ (≤60 sn bayat olabilir — bkz. SITE_SUMMARY_CACHE_TTL_MS): sorgu orders
   * tablosunun tamamını tarar ve bu ekran sık açılır. Bayatlık zararsız çünkü buradaki
   * sayılar YALNIZ gezinme/sunum içindir; hiçbir teslimat/atama kararı bunlara dayanmaz
   * (mağazaya girildiğinde okunan müşteri listesi CANLI sorgudan gelir).
   */
  async siteSummary(): Promise<CustomerSiteSummaryRow[]> {
    const slot = this.siteSummarySlot;
    if (slot.value !== null && Date.now() - slot.at < SITE_SUMMARY_CACHE_TTL_MS) return slot.value;
    // Eşzamanlı çağrılar TEK sorguyu paylaşır (sürü etkisi): ilk çağıran hesabı başlatır,
    // diğerleri aynı promise'e bağlanır. Hata durumunda BAYAT değere düşülmez — hata
    // çağırana yansır (dashboard.counterCached ile aynı takas).
    if (slot.inflight) return slot.inflight;

    const run = this.loadSiteSummary()
      .then((value) => {
        slot.value = value;
        slot.at = Date.now();
        return value;
      })
      .finally(() => {
        slot.inflight = null;
      });
    slot.inflight = run;
    return run;
  }

  /** siteSummary'nin ÖNBELLEKSİZ gövdesi — yalnız yukarıdaki yuva tarafından çağrılır. */
  private async loadSiteSummary(): Promise<CustomerSiteSummaryRow[]> {
    const rows = await rawRows<{
      site_id: string;
      domain: string;
      type: string;
      customer_count: number;
      order_count: number;
      last_order_at: Date | string | null;
    }>(
      this.db,
      sql`
        SELECT
          s.id AS site_id,
          s.domain AS domain,
          s.type::text AS type,
          COUNT(DISTINCT lower(o.customer_email))::int AS customer_count,
          COUNT(o.id)::int AS order_count,
          MAX(o.created_at) AS last_order_at
        FROM sites s
        LEFT JOIN orders o ON o.site_id = s.id
        GROUP BY s.id, s.domain, s.type
        ORDER BY customer_count DESC, s.domain ASC
      `,
    );
    return rows.map((r) => ({
      siteId: r.site_id,
      domain: r.domain,
      type: r.type,
      customerCount: Number(r.customer_count),
      orderCount: Number(r.order_count),
      lastOrderAt: r.last_order_at ? new Date(r.last_order_at).toISOString() : null,
    }));
  }

  async list(
    opts?: { search?: string; siteId?: string },
  ): Promise<{ items: CustomerListRow[]; truncated: boolean }> {
    const term = opts?.search?.trim();
    const siteId = opts?.siteId?.trim();

    // Ana WHERE (orders alias o) — search + opsiyonel site süzgeci.
    //
    // ARAMA = CONTAINS ve ŞU AN SEQ SCAN'dir. Bunu gizlemiyoruz; buradaki eski yorum
    // "SARGABLE — orders_email_lower_idx kullanılabilir" diyordu ve YANLIŞTI:
    //   (a) `%term%` biçimindeki LIKE/ILIKE hiçbir B-tree indeksiyle karşılanamaz (sol ucu açık);
    //   (b) yanına OR'lu bir ÖNEK dalı eklemek de kurtarmaz — OR'un diğer dalı tam tarama
    //       gerektirdiği için planlayıcı tabloyu zaten baştan sona okur. Üstelik önek ⊆ contains
    //       olduğundan o dalın eşleşme kümesine hiçbir katkısı da yoktu → SADECE fazladan iş
    //       üretiyordu; kaldırıldı (dönen satır kümesi AYNEN aynı, davranış değişmedi);
    //   (c) mevcut fonksiyonel indeks `text_pattern_ops` OLMADAN oluşturulduğu için C dışı bir
    //       collation'da `LIKE 'önek%'` optimizasyonunu zaten desteklemez.
    // Contains davranışı BİLİNÇLİ korunuyor: operatör e-postanın ortasında geçen parçayla
    // (alan adı, isim) arıyor — öneke daraltmak "müşteri yok" yanılgısı üretirdi.
    //
    // GERÇEK ÇÖZÜM: `pg_trgm` extension + GIN indeksi (lower(customer_email) gin_trgm_ops).
    // ÖLÇEK-KAPILI olarak ERTELENDİ (bu partide migration/extension eklenmiyor): ekran zaten
    // CUSTOMER_LIST_LIMIT tavanlı ve arama insan hızında/nadir. NE ZAMAN GEREKİR: orders tablosu
    // ~1M satırı geçtiğinde ya da bu sorgunun p95 süresi saniyeye yaklaştığında.
    const searchCond = term ? sql`o.customer_email ILIKE ${'%' + term + '%'}` : null;
    const siteCond = siteId ? sql`o.site_id = ${siteId}` : null;
    let whereClause = sql``;
    if (searchCond && siteCond) whereClause = sql`WHERE ${searchCond} AND ${siteCond}`;
    else if (searchCond) whereClause = sql`WHERE ${searchCond}`;
    else if (siteCond) whereClause = sql`WHERE ${siteCond}`;

    // Alt-sorgu site kapsamı — atama/değişim sayıları da site süzgecine uymalı. Artık ana WHERE
    // değil, aşağıdaki `emails` kümesi filtresine EK koşul (AND) olarak bağlanır.
    const asgSiteFilter = siteId ? sql`AND ord.site_id = ${siteId}` : sql``;
    const repSiteFilter = siteId ? sql`AND site_id = ${siteId}` : sql``;

    // PERF: filtrelenmiş (search+siteId) e-posta kümesini önce CTE'ye (scoped_orders → emails) çıkar.
    // Atama/değişim agregatları ARTIK TÜM tabloyu email bazında toplamıyor; yalnız bu kümeyi tarar
    // (IN (SELECT email FROM emails)) — tek müşteri arandığında bile tam-tablo group-by yapılmıyordu.
    //
    // LIMIT (denetim): daha önce LIMIT KOYULMAMIŞTI çünkü /customers araması İSTEMCİ-TARAFLIdır
    // (customers-table.tsx filterFn) ve konan bir LIMIT eski müşterileri aramada SESSİZCE "yok"
    // göstermişti. Sınırsız bırakmak da sürdürülebilir değil (müşteri sayısı arttıkça yanıt
    // doğrusal büyür). Çözüm SESSİZ DEĞİL: cömert bir tavan + `truncated` bayrağı — operatör
    // listenin kırpıldığını GÖRÜR ve aramayı daraltır (sunucu-taraflı sayfalama gerekirse ayrı iş).
    // Sıralamada stabil ikincil anahtar (email) zaten var → tavan sınırı deterministik.
    //
    // TAVAN+1 çekilir (proje deseni: pending-lines.service / readonly-sql — "tavan+1 çek, JS'te
    // kırp"): eski `LIMIT TAVAN` + `n >= TAVAN` yüklemi TAM 2000 müşteri varken hiçbir şey
    // kırpılmamışken "liste eksik" uyarısı basıyordu (yanlış alarm → operatör GERÇEK kırpmaya
    // da inanmaz olur).
    const rows = await rawRows<{
      email: string;
      order_count: number;
      first_order_at: Date | string | null;
      last_order_at: Date | string | null;
      assignment_count: number;
      replacement_count: number;
      sites: string[] | null;
      tags: string[] | null;
    }>(this.db, sql`
      WITH scoped_orders AS (
        SELECT o.id, o.site_id, o.created_at, lower(o.customer_email) AS email
        FROM orders o
        ${whereClause}
      ),
      emails AS (
        SELECT DISTINCT email FROM scoped_orders
      )
      SELECT
        so.email AS email,
        COUNT(DISTINCT so.id)::int AS order_count,
        MIN(so.created_at) AS first_order_at,
        MAX(so.created_at) AS last_order_at,
        COALESCE(
          array_agg(DISTINCT st.domain) FILTER (WHERE st.domain IS NOT NULL),
          '{}'
        )::text[] AS sites,
        COALESCE(a.assignment_count, 0)::int AS assignment_count,
        COALESCE(r.replacement_count, 0)::int AS replacement_count,
        COALESCE(c.tags, '{}')::text[] AS tags
      FROM scoped_orders so
      LEFT JOIN sites st ON st.id = so.site_id
      LEFT JOIN (
        SELECT lower(ord.customer_email) AS email, COUNT(asg.id) AS assignment_count
        FROM assignments asg
        JOIN orders ord ON ord.id = asg.order_id
        WHERE lower(ord.customer_email) IN (SELECT email FROM emails) ${asgSiteFilter}
        GROUP BY lower(ord.customer_email)
      ) a ON a.email = so.email
      LEFT JOIN (
        SELECT lower(customer_email) AS email, COUNT(*) AS replacement_count
        FROM replacement_requests
        WHERE status = 'approved' AND lower(customer_email) IN (SELECT email FROM emails) ${repSiteFilter}
        GROUP BY lower(customer_email)
      ) r ON r.email = so.email
      LEFT JOIN customers c ON c.email = so.email
      GROUP BY so.email, a.assignment_count, r.replacement_count, c.tags
      ORDER BY MAX(so.created_at) DESC, so.email ASC
      LIMIT ${CUSTOMER_LIST_LIMIT + 1}
    `);

    // Kırpılma sinyali HAM SQL satır sayısından türer (JS süzme yok → sayı birebir aynı).
    // TAVAN+1 çekildiği için `>` KESİN sinyaldir: tam TAVAN kadar müşteride uyarı BASILMAZ.
    const truncated = rows.length > CUSTOMER_LIST_LIMIT;

    // Tespit için çekilen fazladan satır YANITA GİRMEZ (sözleşme: en fazla TAVAN satır).
    const items = rows.slice(0, CUSTOMER_LIST_LIMIT).map((row) => {
      const assignmentCount = Number(row.assignment_count);
      const replacementCount = Number(row.replacement_count);
      return {
        email: row.email,
        orderCount: Number(row.order_count),
        assignmentCount,
        replacementCount,
        replacementRate: rate(replacementCount, assignmentCount),
        tags: row.tags ?? [],
        sites: row.sites ?? [],
        firstOrderAt: row.first_order_at ? new Date(row.first_order_at).toISOString() : null,
        lastOrderAt: row.last_order_at ? new Date(row.last_order_at).toISOString() : null,
      };
    });
    return { items, truncated };
  }

  /** Tek müşteri detayı — kalıcı meta + istatistik + sipariş/değişim geçmişi. */
  async detail(email: string): Promise<CustomerDetail> {
    const key = email.trim().toLowerCase();

    // Kalıcı meta (varsa) — tags/notes.
    const [meta] = await this.db
      .select({ tags: customers.tags, notes: customers.notes })
      .from(customers)
      .where(eq(customers.email, key))
      .limit(1);

    // Türetilmiş istatistik (orders/assignments + RAW replacement_requests).
    const statRows = await rawRows<{
      order_count: number;
      assignment_count: number;
      replacement_count: number;
    }>(this.db, sql`
      SELECT
        (SELECT COUNT(*)::int FROM orders o WHERE lower(o.customer_email) = ${key}) AS order_count,
        (SELECT COUNT(*)::int FROM assignments asg
           JOIN orders o ON o.id = asg.order_id
           WHERE lower(o.customer_email) = ${key}) AS assignment_count,
        (SELECT COUNT(*)::int FROM replacement_requests
           WHERE lower(customer_email) = ${key} AND status = 'approved') AS replacement_count
    `);
    const s = statRows[0] ?? { order_count: 0, assignment_count: 0, replacement_count: 0 };
    const assignmentCount = Number(s.assignment_count);
    const replacementCount = Number(s.replacement_count);

    // Sipariş geçmişi + mağaza bağlamı (sites LEFT JOIN — site silinmişse satır DÜŞMEZ, domain null).
    const orderRows = await rawRows<{
      id: string;
      remote_order_id: string;
      status: string;
      created_at: Date | string;
      site_domain: string | null;
    }>(this.db, sql`
      SELECT o.id, o.remote_order_id, o.status, o.created_at, s.domain AS site_domain
      FROM orders o
      LEFT JOIN sites s ON s.id = o.site_id
      WHERE lower(o.customer_email) = ${key}
      ORDER BY o.created_at DESC
    `);

    // Değişim geçmişi — RAW SQL (drizzle import YOK). Sipariş JOIN'i talebi TIKLANABİLİR yapar
    // (PK eşitliği; müşteri başına satır sayısı küçük → ek tarama maliyeti yok).
    const replacementRows = await rawRows<{
      id: string;
      status: string;
      reason: string;
      created_at: Date | string;
      order_id: string | null;
      remote_order_id: string | null;
      site_domain: string | null;
    }>(this.db, sql`
      SELECT rr.id, rr.status, rr.reason, rr.created_at,
             rr.order_id, o.remote_order_id, s.domain AS site_domain
      FROM replacement_requests rr
      LEFT JOIN orders o ON o.id = rr.order_id
      LEFT JOIN sites s ON s.id = rr.site_id
      WHERE lower(rr.customer_email) = ${key}
      ORDER BY rr.created_at DESC
    `);

    return {
      email: key,
      tags: meta?.tags ?? [],
      notes: meta?.notes ?? null,
      stats: {
        orderCount: Number(s.order_count),
        assignmentCount,
        replacementCount,
        replacementRate: rate(replacementCount, assignmentCount),
      },
      orders: orderRows.map((o) => ({
        id: o.id,
        remoteOrderId: o.remote_order_id,
        status: o.status,
        createdAt: new Date(o.created_at).toISOString(),
        siteDomain: o.site_domain ?? null,
      })),
      replacements: replacementRows.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        createdAt: new Date(r.created_at).toISOString(),
        orderId: r.order_id ?? null,
        remoteOrderId: r.remote_order_id ?? null,
        siteDomain: r.site_domain ?? null,
      })),
    };
  }

  /**
   * Müşteri meta güncelle (upsert) — yalnız verilen alanlar değişir. e-posta lowercase.
   * Kayıt yoksa oluşturulur (varsayılan tags=[], notes=null).
   */
  async update(
    email: string,
    input: { tags?: string[]; notes?: string | null },
  ): Promise<{ email: string; tags: string[]; notes: string | null }> {
    const key = email.trim().toLowerCase();

    // onConflictDoUpdate set'i yalnız verilen alanları içerir; updatedAt daima tazelenir.
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (input.tags !== undefined) set.tags = input.tags;
    if (input.notes !== undefined) set.notes = input.notes;

    const [row] = await this.db
      .insert(customers)
      .values({
        email: key,
        tags: input.tags ?? [],
        notes: input.notes ?? null,
      })
      .onConflictDoUpdate({ target: customers.email, set })
      .returning({ email: customers.email, tags: customers.tags, notes: customers.notes });

    return { email: row.email, tags: row.tags, notes: row.notes };
  }
}
