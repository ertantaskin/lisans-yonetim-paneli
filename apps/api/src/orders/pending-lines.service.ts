import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import {
  auditLog,
  fulfillmentEvents,
  licenseItems,
  orderLines,
  orders,
  products,
  sites,
} from '../db/schema';
import { rawRows } from '../db/raw-query';
import { notExpiredCond } from '../assignment/assign';
import { ProductsService } from '../products/products.service';
import { FulfillmentService } from './fulfillment.service';
import { recomputeOrderStatus } from './order-status';
import { remainingUnits } from './fill-target';

/**
 * Bekleyen (eşlemesiz) sipariş satırlarının tanılaması + eşleme-sonrası GERİYE DÖNÜK çözümü (§3/§4).
 *
 * PROBLEM: createOrder eşleme bulamazsa satırı `product_id = NULL` + status 'pending' yazar
 * (sipariş kaybolmaz, yanlış teslim de yapılmaz). Operatör ürünü SONRADAN /mappings ekranından
 * eşleyince o satır kendiliğinden çözülmez: tamamlama motoru (autoCompleteProduct) satırları
 * `product_id` üzerinden tarar → product_id NULL olan satır hiçbir sweep'e girmez, "Kalanları Ata"
 * da (completeLine) product_id yoksa no-op döner. Sonuç: operatör eşlemeyi yapar ama sipariş
 * "eşlenmemiş" görünmeye devam eder.
 *
 * ÇÖZÜM: bu servis MEVCUT eşlemeleri geriye dönük UYGULAR (satırı ürüne bağlar + bundleQty
 * ölçeklemesini yazar) ve ardından NORMAL atama makinesini (completeLine) çalıştırır.
 *
 * KRİTİK — OTOMATİK EŞLEŞTİRME YOK: burada hiçbir eşleme OLUŞTURULMAZ/TAHMİN EDİLMEZ. Yalnızca
 * operatörün ELLE tanımladığı, `site_product_mappings` içinde AKTİF duran eşlemeler uygulanır
 * (resolveMapping: varyasyon-özel → ürün-seviyesi fallback). Eşleme yoksa satıra DOKUNULMAZ.
 */

/** resolvePending girdisi — hepsi opsiyonel; verilmeyen alan "daraltma yok" demektir. */
export interface ResolvePendingInput {
  siteId?: string;
  remoteProductId?: string;
  /** null = "varyasyonsuz (ürün-seviyesi) satırlar"; undefined = varyasyon filtresi yok. */
  remoteVariationId?: string | null;
  orderId?: string;
  lineId?: string;
}

export type ResolveOutcome = 'delivered' | 'partial' | 'pending' | 'no-mapping' | 'skipped';

export interface ResolveDetail {
  lineId: string;
  orderId: string;
  remoteOrderId: string;
  siteId: string;
  siteDomain: string;
  remoteProductId: string | null;
  remoteVariationId: string | null;
  remoteName: string | null;
  productId: string | null;
  productName: string | null;
  qtyBefore: number;
  qtyAfter: number;
  bundleQty: number | null;
  outcome: ResolveOutcome;
  message: string;
}

export interface ResolvePendingResult {
  scanned: number;
  linked: number;
  delivered: number;
  stillPending: number;
  noMapping: number;
  skipped: number;
  /** Tarama sınırına (500 satır) takıldıysa true → operatör tekrar çalıştırmalı. */
  truncated: boolean;
  details: ResolveDetail[];
}

/** Bir grubun neden beklediği (özet ekranı rozetleri). */
export type PendingReason = 'mapping-available' | 'unmapped' | 'no-remote-id';

export interface PendingGroup {
  siteId: string;
  siteDomain: string;
  remoteProductId: string | null;
  remoteVariationId: string | null;
  remoteName: string | null;
  lineCount: number;
  orderCount: number;
  totalQty: number;
  oldestAt: string;
  /** true = eşleme ARTIK var (operatör eşledi) → tek tıkla çözülebilir. */
  mappedNow: boolean;
  /** İnceleme kuyruğundaki (held_for_review) satır sayısı — çözülse de teslim edilmez. */
  heldCount: number;
  reason: PendingReason;
  hint: string;
}

export interface PendingSummary {
  groups: PendingGroup[];
  /** Grup listesi üst sınıra dayandı mı — true ise ekranda "hepsi bu kadar" DENMEMELİ. */
  truncated: boolean;
  totals: {
    groupCount: number;
    lineCount: number;
    orderCount: number;
    totalQty: number;
    /** Eşlemesi ARTIK olan (tek tıkla çözülebilir) grup/satır sayısı. */
    resolvableGroups: number;
    resolvableLines: number;
  };
}

/** Bir sipariş satırının "neden bu durumda" tanısı (sipariş detayı ekranı). */
export type LineDiagnosisReason =
  | 'ok'
  | 'canceled'
  | 'no-remote-id'
  | 'unmapped'
  | 'mapping-available'
  | 'held'
  | 'preorder'
  | 'out-of-stock'
  | 'ready';

/** Operatörün atması gereken adım — UI buton/derin-bağlantı seçer. */
export type LineDiagnosisAction = 'none' | 'map' | 'resolve' | 'review' | 'stock' | 'complete';

export interface LineDiagnosis {
  lineId: string;
  remoteLineId: string;
  remoteProductId: string | null;
  remoteVariationId: string | null;
  remoteName: string | null;
  productId: string | null;
  productName: string | null;
  qty: number;
  /**
   * Panelden KALICI iptal edilmiş birim (fill-target.ts). Hedef = `qty − canceledUnits`;
   * tanının içindeki `remaining` bu deftere göre hesaplanıyordu ama alan yanıta GİRMİYORDU →
   * istemci aynı satır için `qty − fulfilledQty` ile FARKLI bir "kalan" üretiyordu.
   * Kardeş yüzey `admin-orders.detail()` ile aynı gerekçe: hedefin girdisi tek deftere bağlı olmalı.
   */
  canceledUnits: number;
  fulfilledQty: number;
  status: string;
  canceled: boolean;
  reason: LineDiagnosisReason;
  action: LineDiagnosisAction;
  message: string;
  /** Ürün için anlık kullanılabilir KAPASİTE (multi/MAK'ta Σ max_uses−use_count). */
  availableStock: number | null;
}

export interface OrderDiagnosis {
  orderId: string;
  remoteOrderId: string;
  siteId: string;
  siteDomain: string;
  heldForReview: boolean;
  /** Eşlemesi hazır olduğu için "Eşlemeyi uygula" ile çözülebilecek satır sayısı. */
  resolvableCount: number;
  lines: LineDiagnosis[];
}

/** Tek çağrıda taranacak azami satır (uzun kuyrukta istek şişmesin; truncated ile raporlanır). */
const RESOLVE_LIMIT = 500;
/** Özet ekranında tek seferde dönen en fazla grup — sınıra dayanırsa `truncated` bildirilir. */
const GROUP_LIMIT = 500;

@Injectable()
export class PendingLinesService {
  private readonly logger = new Logger(PendingLinesService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly products: ProductsService,
    private readonly fulfillment: FulfillmentService,
  ) {}

  /**
   * Eşlemesiz bekleyen satırların GRUPLANMIŞ özeti (site + mağaza ürünü/varyasyonu bazında).
   * `mappedNow` = eşleme ARTIK var → "eşledin ama satırlar hâlâ bekliyor, tek tık çöz" durumu.
   * Tek sorgu (N+1 yok); mağaza ürün kimliği hiç gelmemiş ESKİ satırlar da ayrı bir sebep
   * (`no-remote-id`) ile listelenir — operatör "neden bekliyor" sorusunu ekrandan yanıtlar.
   */
  async summary(): Promise<PendingSummary> {
    const rows = await rawRows<{
      site_id: string;
      domain: string;
      remote_product_id: string | null;
      remote_variation_id: string | null;
      remote_name: string | null;
      line_count: number;
      order_count: number;
      total_qty: number;
      oldest_at: string;
      mapped_now: boolean;
      held_count: number;
    }>(
      this.db,
      sql`
        WITH pending AS (
          SELECT o.site_id,
                 s.domain,
                 ol.remote_product_id,
                 NULLIF(NULLIF(ol.remote_variation_id, '0'), '') AS variation,
                 ol.remote_name,
                 ol.qty,
                 ol.order_id,
                 o.created_at,
                 o.held_for_review,
                 -- resolveMapping ile AYNI mantık: varyasyon-özel VEYA ürün-seviyesi aktif eşleme.
                 EXISTS (
                   SELECT 1 FROM site_product_mappings m
                   WHERE m.site_id = o.site_id
                     AND m.remote_product_id = ol.remote_product_id
                     AND m.active = true
                     AND (
                       m.remote_variation_id IS NULL
                       OR m.remote_variation_id = NULLIF(NULLIF(ol.remote_variation_id, '0'), '')
                     )
                 ) AS mapped_now
          FROM order_lines ol
          JOIN orders o ON ol.order_id = o.id
          JOIN sites s ON o.site_id = s.id
          WHERE ol.product_id IS NULL
            AND ol.canceled = false
            AND ol.status IN ('pending', 'partial')
        )
        SELECT site_id,
               domain,
               remote_product_id,
               variation AS remote_variation_id,
               MAX(remote_name) AS remote_name,
               COUNT(*)::int AS line_count,
               COUNT(DISTINCT order_id)::int AS order_count,
               COALESCE(SUM(qty), 0)::int AS total_qty,
               MIN(created_at) AS oldest_at,
               BOOL_OR(mapped_now) AS mapped_now,
               COUNT(*) FILTER (WHERE held_for_review)::int AS held_count
        FROM pending
        GROUP BY site_id, domain, remote_product_id, variation
        -- Çıktı takma-adı yerine AÇIK ifade: 'mapped_now' hem CTE kolonu hem çıktı adı olduğu
        -- için sıralamada belirsizlik doğmasın (çözülebilir gruplar önce, sonra en eski).
        --
        -- TIE-BREAK ZORUNLU: LIMIT'li her ORDER BY'ın deterministik son anahtarı olmalı. Aynı
        -- saniyede yazılmış siparişlerde (toplu import/resync sıradan bir durum) sıra keyfi
        -- kalırsa tavana dayanan listede HANGİ grubun pencereye gireceği çağrıdan çağrıya
        -- değişir → operatör aynı ekranı yenilediğinde grup kaybolur/geri gelir. Grup anahtarı
        -- (site, mağaza ürünü, varyasyon) tekil olduğu için sıralamayı tam belirler.
        ORDER BY BOOL_OR(mapped_now) DESC,
                 MIN(created_at) ASC,
                 site_id ASC,
                 remote_product_id ASC NULLS LAST,
                 variation ASC NULLS LAST
        -- TAVAN+1 (proje deseni — aynı dosyadaki findCandidates / customers.list): eski
        -- "LIMIT TAVAN" + "n >= TAVAN" yüklemi TAM 500 grup varken hiçbir şey kırpılmamışken
        -- "liste eksik" uyarısı basıyordu. Yanlış alarm, GERÇEK kırpma uyarısını da değersizleştirir.
        -- (DİKKAT: bu blok bir sql şablon literalinin İÇİNDE — yorumda TERS TIRNAK kullanmak
        --  şablonu erken kapatır ve derleme kırılır; bu projede tekrarlayan bir tuzak.)
        LIMIT ${sql.raw(String(GROUP_LIMIT + 1))}
      `,
    );

    // Kırpılma TESPİTİ için çekilen fazladan satır YANITA GİRMEZ (sözleşme: en fazla GROUP_LIMIT).
    const groups: PendingGroup[] = rows.slice(0, GROUP_LIMIT).map((r) => {
      const mappedNow = Boolean(r.mapped_now) && r.remote_product_id !== null;
      const reason: PendingReason = !r.remote_product_id
        ? 'no-remote-id'
        : mappedNow
          ? 'mapping-available'
          : 'unmapped';
      return {
        siteId: r.site_id,
        siteDomain: r.domain,
        remoteProductId: r.remote_product_id,
        remoteVariationId: r.remote_variation_id,
        remoteName: r.remote_name,
        lineCount: Number(r.line_count),
        orderCount: Number(r.order_count),
        totalQty: Number(r.total_qty),
        oldestAt: r.oldest_at,
        mappedNow,
        heldCount: Number(r.held_count),
        reason,
        hint:
          reason === 'mapping-available'
            ? 'Eşleme yapılmış ama satırlar eşleme öncesinden kalmış — "Eşlemeyi uygula" ile çözülüp teslimat denenir.'
            : reason === 'unmapped'
              ? 'Bu mağaza ürünü panel ürünüyle eşlenmemiş — önce Ürün Eşleştirme ekranından eşleyin.'
              : 'Satırda mağaza ürün kimliği yok (eski eklenti sürümüyle gelmiş) — mağazadan siparişi yeniden gönderin/senkronlayın.',
      };
    });

    // Sipariş sayısı GRUP TOPLAMI olamaz: iki farklı eşlemesiz mağaza ürünü içeren TEK sipariş
    // iki grupta birden görünür → toplam şişerdi ("3 sipariş bekliyor" derken gerçekte 1 var).
    // Global tekil sayım ayrı sorguyla alınır (grup LIMIT'inden de bağımsızdır).
    const [distinct] = await rawRows<{ order_count: number }>(
      this.db,
      sql`
        SELECT COUNT(DISTINCT ol.order_id)::int AS order_count
        FROM order_lines ol
        WHERE ol.product_id IS NULL
          AND ol.canceled = false
          AND ol.status IN ('pending', 'partial')
      `,
    );

    return {
      groups,
      // Grup sorgusu GROUP_LIMIT ile sınırlı — GERÇEKTEN kırpıldıysa dürüstçe bildir (sessiz
      // kırpma "hepsi bu kadar" izlenimi verirdi; CLAUDE.md "no silent caps").
      // TAVAN+1 çekildiği için `>` KESİN sinyaldir: tam GROUP_LIMIT grupta uyarı BASILMAZ.
      truncated: rows.length > GROUP_LIMIT,
      totals: {
        groupCount: groups.length,
        lineCount: groups.reduce((s, g) => s + g.lineCount, 0),
        orderCount: Number(distinct?.order_count ?? 0),
        totalQty: groups.reduce((s, g) => s + g.totalQty, 0),
        resolvableGroups: groups.filter((g) => g.mappedNow).length,
        resolvableLines: groups.filter((g) => g.mappedNow).reduce((s, g) => s + g.lineCount, 0),
      },
    };
  }

  /**
   * MEVCUT eşlemeleri bekleyen satırlara geriye dönük uygular ve teslimatı dener.
   *
   * Akış (satır başına): eşleme çöz (yoksa ATLA) → advisory-lock'lu tx'te satırı FOR UPDATE ile
   * kilitle + product_id'nin HÂLÂ NULL olduğunu doğrula (TOCTOU) → product_id + qty×bundleQty yaz →
   * tx DIŞINDA completeLine (normal atama makinesi; held/canceled/all-or-nothing kurallarını
   * KENDİSİ uygular — burada BYPASS EDİLMEZ).
   *
   * İdempotent: ikinci çağrı satırı product_id dolu bulur → 'skipped' (çifte atama üretmez).
   */
  async resolvePending(input: ResolvePendingInput, actor: string): Promise<ResolvePendingResult> {
    const { rows: candidates, truncated } = await this.findCandidates(input);

    const details: ResolveDetail[] = [];
    let linked = 0;
    let delivered = 0;
    let stillPending = 0;
    let noMapping = 0;
    let skipped = 0;

    // (site, mağaza ürünü, varyasyon) → eşleme önbelleği: aynı grubun N satırı için
    // resolveMapping'i N kez çağırmayalım (N+1 sorgu). Ürün adı da bir kez okunur.
    const mappingCache = new Map<
      string,
      { productId: string; bundleQty: number; productName: string | null } | null
    >();

    for (const c of candidates) {
      const base = {
        lineId: c.lineId,
        orderId: c.orderId,
        remoteOrderId: c.remoteOrderId,
        siteId: c.siteId,
        siteDomain: c.siteDomain,
        remoteProductId: c.remoteProductId,
        remoteVariationId: c.remoteVariationId,
        remoteName: c.remoteName,
        qtyBefore: c.qty,
      };

      // Mağaza ürün kimliği olmayan (eski eklentiden gelmiş) satır çözülemez — uydurmayız.
      if (!c.remoteProductId) {
        skipped++;
        details.push({
          ...base,
          productId: null,
          productName: null,
          qtyAfter: c.qty,
          bundleQty: null,
          outcome: 'skipped',
          message:
            'Satırda mağaza ürün kimliği yok (eski kayıt) — eşleme çözülemez, mağazadan yeniden senkronlayın.',
        });
        continue;
      }

      const variation =
        c.remoteVariationId && c.remoteVariationId !== '0' ? c.remoteVariationId : null;
      const cacheKey = `${c.siteId}:${c.remoteProductId}:${variation ?? ''}`;
      let mapping = mappingCache.get(cacheKey);
      if (mapping === undefined) {
        // OTOMATİK EŞLEŞTİRME YOK: yalnız operatörün tanımladığı AKTİF eşleme okunur.
        const m = await this.products.resolveMapping(c.siteId, c.remoteProductId, variation);
        mapping = m ? { ...m, productName: await this.productName(m.productId) } : null;
        mappingCache.set(cacheKey, mapping);
      }

      if (!mapping) {
        noMapping++;
        details.push({
          ...base,
          productId: null,
          productName: null,
          qtyAfter: c.qty,
          bundleQty: null,
          outcome: 'no-mapping',
          message:
            'Bu mağaza ürünü için aktif eşleme yok — önce Ürün Eşleştirme ekranından panel ürününü seçin.',
        });
        continue;
      }

      const link = await this.linkLine(c.lineId, c.orderId, mapping, actor, c);
      if (!link.ok) {
        skipped++;
        details.push({
          ...base,
          productId: mapping.productId,
          productName: mapping.productName,
          qtyAfter: c.qty,
          bundleQty: mapping.bundleQty,
          outcome: 'skipped',
          message: link.message,
        });
        continue;
      }

      linked++;

      // Teslimat NORMAL makineyle: completeLine held siparişi / iptal satırı / all-or-nothing
      // politikasını kendi içinde onurlandırır. Hata bir satırı düşürür, turu DEĞİL.
      let status = 'pending';
      let added = 0;
      let failure: string | null = null;
      try {
        const res = await this.fulfillment.completeLine(c.lineId);
        status = res.status;
        added = res.added;
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        this.logger.warn(`pending-line teslimat denemesi başarısız (line ${c.lineId}): ${failure}`);
      }

      const outcome: ResolveOutcome =
        status === 'fulfilled' ? 'delivered' : added > 0 ? 'partial' : 'pending';
      if (outcome === 'delivered') delivered++;
      else stillPending++;

      details.push({
        ...base,
        productId: mapping.productId,
        productName: mapping.productName,
        qtyBefore: link.qtyBefore,
        qtyAfter: link.qtyAfter,
        bundleQty: mapping.bundleQty,
        outcome,
        message: failure
          ? `Ürün eşlendi ama teslimat denemesi hata verdi: ${failure}. Stok girince/tekrar denendiğinde tamamlanır.`
          : outcome === 'delivered'
            ? `Ürün eşlendi ve ${link.qtyAfter} birim teslim edildi.`
            : c.held
              ? 'Ürün eşlendi; sipariş İnceleme Kuyruğunda (onaylanınca teslim edilecek).'
              : outcome === 'partial'
                ? `Ürün eşlendi; ${added}/${link.qtyAfter} birim teslim edildi (stok yetersiz).`
                : 'Ürün eşlendi; teslimat bekliyor (stok yetersiz ya da ön sipariş/politika kısıtı).',
      });
    }

    return {
      scanned: candidates.length,
      linked,
      delivered,
      stillPending,
      noMapping,
      skipped,
      truncated,
      details,
    };
  }

  /**
   * Bir siparişin satır satır "neden bu durumda" tanısı (§13 tanılama). Salt-okunur.
   * Eşlemesiz satırlarda eşlemenin ARTIK var olup olmadığını da söyler → sipariş detayı
   * ekranı "Eşlemeyi uygula" butonunu gösterebilir. 2 sorgu (N+1 yok).
   */
  async diagnose(orderId: string): Promise<OrderDiagnosis> {
    const [order] = await this.db
      .select({
        id: orders.id,
        remoteOrderId: orders.remoteOrderId,
        siteId: orders.siteId,
        held: orders.heldForReview,
        domain: sites.domain,
      })
      .from(orders)
      .innerJoin(sites, eq(orders.siteId, sites.id))
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    const rows = await rawRows<{
      id: string;
      remote_line_id: string;
      remote_product_id: string | null;
      remote_variation_id: string | null;
      remote_name: string | null;
      product_id: string | null;
      product_name: string | null;
      qty: number;
      fulfilled_qty: number;
      // R1: doldurma hedefi `qty − canceled_units` (fill-target.ts) — tanı "kaç birim eksik"i
      // bu deftere göre hesaplamak ZORUNDA, yoksa iptal edilmiş birimi "bekleyen iş" sanar.
      canceled_units: number | null;
      status: string;
      canceled: boolean;
      stockless: boolean | null;
      release_at: string | null;
      policy: string | null;
      mapping_available: boolean;
    }>(
      this.db,
      sql`
        SELECT ol.id,
               ol.remote_line_id,
               ol.remote_product_id,
               NULLIF(NULLIF(ol.remote_variation_id, '0'), '') AS remote_variation_id,
               ol.remote_name,
               ol.product_id,
               p.name AS product_name,
               ol.qty,
               ol.fulfilled_qty,
               ol.canceled_units,
               ol.status,
               ol.canceled,
               p.stockless,
               p.release_at,
               COALESCE(ol.policy_override, p.fulfillment_policy) AS policy,
               EXISTS (
                 SELECT 1 FROM site_product_mappings m
                 WHERE m.site_id = ${order.siteId}
                   AND m.remote_product_id = ol.remote_product_id
                   AND m.active = true
                   AND (
                     m.remote_variation_id IS NULL
                     OR m.remote_variation_id = NULLIF(NULLIF(ol.remote_variation_id, '0'), '')
                   )
               ) AS mapping_available
        FROM order_lines ol
        LEFT JOIN products p ON ol.product_id = p.id
        WHERE ol.order_id = ${orderId}
        -- TIE-BREAK (ol.id) ŞART: bir siparişin TÜM satırları aynı transaction'da yazılır →
        -- created_at damgaları BİREBİR aynıdır. Tie-break'siz tanı listesi her yenilemede
        -- FARKLI sırada gelir; operatör "satır sırası değişti, bir şey mi oldu?" sanır ve
        -- sıra 'çöz' yolununkiyle (findCandidates) de tutmaz. Yön ayna: ASC + ASC.
        ORDER BY ol.created_at ASC, ol.id ASC
      `,
    );

    // Ürün başına anlık kapasite (multi/MAK: Σ max_uses−use_count) — tek grup sorgusu.
    //
    // notExpiredCond('license_items'): atama sorgusuyla (assign.ts) AYNI küme. Bu sayı TANIYA
    // girdi olur ("stok hazır — Kalanları Ata" vs "stok yetersiz"); süresi geçmiş kalemler
    // sayılırsa tanı "stok var" der, teslimat 0 atar ve operatör yanlış yönlendirilir.
    // (Drizzle sorgu kurucusu tabloyu takma adsız basar → alias = tablo adı.)
    const productIds = [...new Set(rows.map((r) => r.product_id).filter((v): v is string => !!v))];
    const stock = new Map<string, number>();
    if (productIds.length > 0) {
      const agg = await this.db
        .select({
          productId: licenseItems.productId,
          available: sql<number>`coalesce(sum(${licenseItems.maxUses} - ${licenseItems.useCount}), 0)`,
        })
        .from(licenseItems)
        .where(
          and(
            inArray(licenseItems.productId, productIds),
            eq(licenseItems.status, 'available'),
            notExpiredCond('license_items'),
          ),
        )
        .groupBy(licenseItems.productId);
      for (const a of agg) stock.set(a.productId, Number(a.available));
    }

    const lines: LineDiagnosis[] = rows.map((r) => {
      const available = r.product_id ? (stock.get(r.product_id) ?? 0) : null;
      /*
       * R1 (TEK TANIM): kalan birim = hedef − teslim edilen; hedef `qty − canceled_units`
       * (fill-target.ts `remainingUnits`). Ham `qty − fulfilled_qty` yazılıydı → panelden
       * KALICI iptal edilmiş birimler tanıda hâlâ eksik sayılıyor ve satır "stok yok / kısmi"
       * gibi işaretleniyordu. Oysa `completeLine` aynı satırı ASLA doldurmaz (hedefi bu
       * defterden okur) → operatöre kapanmayacak bir iş gösteriliyordu.
       */
      const remaining = remainingUnits({
        qty: Number(r.qty),
        canceledUnits: r.canceled_units,
        fulfilledQty: Number(r.fulfilled_qty),
      });
      const d = this.diagnoseLine(r, order.held, available, remaining);
      return {
        lineId: r.id,
        remoteLineId: r.remote_line_id,
        remoteProductId: r.remote_product_id,
        remoteVariationId: r.remote_variation_id,
        remoteName: r.remote_name,
        productId: r.product_id,
        productName: r.product_name,
        qty: Number(r.qty),
        // Hedefin ikinci girdisi (yukarıdaki `remaining` bunu zaten kullanıyor) — sunum
        // "kalan"ı aynı defterden türetsin diye yanıta da girer.
        canceledUnits: Number(r.canceled_units ?? 0),
        fulfilledQty: Number(r.fulfilled_qty),
        status: r.status,
        canceled: Boolean(r.canceled),
        availableStock: available,
        ...d,
      };
    });

    return {
      orderId: order.id,
      remoteOrderId: order.remoteOrderId,
      siteId: order.siteId,
      siteDomain: order.domain,
      heldForReview: Boolean(order.held),
      resolvableCount: lines.filter((l) => l.reason === 'mapping-available').length,
      lines,
    };
  }

  // ─── iç yardımcılar ────────────────────────────────────────────────────────────────

  /** Tek satırın tanısı — sebep + operatörün atacağı adım + Türkçe açıklama. */
  private diagnoseLine(
    r: {
      product_id: string | null;
      remote_product_id: string | null;
      canceled: boolean;
      status: string;
      mapping_available: boolean;
      stockless: boolean | null;
      release_at: string | null;
      policy: string | null;
    },
    held: boolean,
    available: number | null,
    remaining: number,
  ): { reason: LineDiagnosisReason; action: LineDiagnosisAction; message: string } {
    if (r.canceled) {
      return {
        reason: 'canceled',
        action: 'none',
        message: 'Satır iade/iptal edilmiş — yeniden teslim edilmez (§2).',
      };
    }
    if (r.status === 'fulfilled') {
      return { reason: 'ok', action: 'none', message: 'Satır tamamen teslim edildi.' };
    }
    if (!r.product_id) {
      if (!r.remote_product_id) {
        return {
          reason: 'no-remote-id',
          action: 'none',
          message:
            'Mağaza ürün kimliği kayıtlı değil (eski eklenti sürümü) — siparişi mağazadan yeniden gönderin.',
        };
      }
      if (r.mapping_available) {
        return {
          reason: 'mapping-available',
          action: 'resolve',
          message:
            'Ürün eşlemesi artık var ama satır eşleme öncesinden kalmış — "Eşlemeyi uygula" ile çözülür.',
        };
      }
      return {
        reason: 'unmapped',
        action: 'map',
        message:
          'Bu mağaza ürünü panel ürünüyle eşlenmemiş — Ürün Eşleştirme ekranından eşleyin (teslimat eşleme sonrası yapılır).',
      };
    }
    if (held) {
      return {
        reason: 'held',
        action: 'review',
        message: 'Sipariş İnceleme Kuyruğunda — onaylandığında teslimat başlar.',
      };
    }
    if (r.stockless && r.release_at && new Date(r.release_at).getTime() > Date.now()) {
      // release_at postgres-js'ten Date olarak gelir; ham toString() İngilizce/uzun olduğu için
      // kullanıcıya ISO tarih (YYYY-AA-GG) verilir — UI dilediği gibi biçimlendirir.
      const release = new Date(r.release_at).toISOString().slice(0, 10);
      return {
        reason: 'preorder',
        action: 'none',
        message: `Ön sipariş — yayın tarihinden (${release}) önce teslim edilmez.`,
      };
    }
    if ((available ?? 0) < remaining) {
      return {
        reason: 'out-of-stock',
        action: 'stock',
        message:
          r.policy === 'all-or-nothing'
            ? `Stok yetersiz (gereken ${remaining}, kullanılabilir ${available ?? 0}). Politika "tümü ya da hiç" — tamamı hazır olmadan hiçbir birim teslim edilmez.`
            : `Stok yetersiz (gereken ${remaining}, kullanılabilir ${available ?? 0}) — stok girilince otomatik tamamlanır.`,
      };
    }
    return {
      reason: 'ready',
      action: 'complete',
      message: `Stok hazır (${available ?? 0} kullanılabilir) — "Kalanları Ata" ile teslim edilebilir.`,
    };
  }

  /** Ürün adı (eşleme önbelleği ile birlikte grup başına bir kez okunur). */
  private async productName(productId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ name: products.name })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    return row?.name ?? null;
  }

  /**
   * Aday satırlar: eşlemesiz (product_id NULL), iptal EDİLMEMİŞ, pending/partial satırlar.
   * FIFO sırası autoComplete ile aynı (öncelik desc, sipariş tarihi asc) → aynı ürüne yarışan
   * satırlarda eski sipariş önce doyar.
   */
  private async findCandidates(input: ResolvePendingInput) {
    const conds = [
      isNull(orderLines.productId),
      // İade/iptal edilmiş satır ASLA yeniden teslim edilmez (§2) — çözüme de girmez.
      eq(orderLines.canceled, false),
      inArray(orderLines.status, ['pending', 'partial']),
    ];
    if (input.lineId) conds.push(eq(orderLines.id, input.lineId));
    if (input.orderId) conds.push(eq(orderLines.orderId, input.orderId));
    if (input.siteId) conds.push(eq(orders.siteId, input.siteId));
    if (input.remoteProductId) conds.push(eq(orderLines.remoteProductId, input.remoteProductId));
    if (input.remoteVariationId !== undefined) {
      // '0'/boş varyasyon = varyasyon yok (resolveMapping ile AYNI normalizasyon).
      const variation =
        input.remoteVariationId && input.remoteVariationId !== '0' ? input.remoteVariationId : null;
      conds.push(
        variation
          ? sql`NULLIF(NULLIF(${orderLines.remoteVariationId}, '0'), '') = ${variation}`
          : sql`NULLIF(NULLIF(${orderLines.remoteVariationId}, '0'), '') IS NULL`,
      );
    }

    const rows = await this.db
      .select({
        lineId: orderLines.id,
        orderId: orderLines.orderId,
        qty: orderLines.qty,
        remoteProductId: orderLines.remoteProductId,
        remoteVariationId: orderLines.remoteVariationId,
        remoteName: orderLines.remoteName,
        remoteOrderId: orders.remoteOrderId,
        siteId: orders.siteId,
        held: orders.heldForReview,
        siteDomain: sites.domain,
      })
      .from(orderLines)
      .innerJoin(orders, eq(orderLines.orderId, orders.id))
      .innerJoin(sites, eq(orders.siteId, sites.id))
      .where(and(...conds))
      /*
       * TIE-BREAK (orderLines.id) ŞART. Burada eşitlik ihtimal değil GARANTİ: sıralama
       * `orders.created_at` üzerinden yapılıyor ve ÇOK KALEMLİ bir siparişin N satırı aynı
       * sipariş tarihini paylaşır. Tie-break'siz `limit(RESOLVE_LIMIT + 1)` penceresine hangi
       * satırların gireceği KEYFİ olur → "tanı" (diagnose) ile "çöz" (resolve) çağrıları
       * FARKLI alt küme işleyebilir: operatör ekranda gördüğü satırın çözüldüğünü sanır ama
       * başka bir satır işlenmiş olur. Yön ayna: ASC sıralamada tie-break de ASC.
       * `autoCompleteProduct` ile aynı desen (iki FIFO penceresi hizalı kalmalı).
       */
      .orderBy(desc(orderLines.priority), asc(orders.createdAt), asc(orderLines.id))
      .limit(RESOLVE_LIMIT + 1);

    return { rows: rows.slice(0, RESOLVE_LIMIT), truncated: rows.length > RESOLVE_LIMIT };
  }

  /**
   * Satırı ürüne bağlar (product_id + qty×bundleQty) — atama YAPMAZ.
   *
   * KRİTİK (qty ölçekleme): eşlemesiz satır kaydedilirken qty HAM mağaza adedi yazılır
   * (createOrder unmapped dalı bundleQty uygulayamaz — eşleme yok). Eşleme sonradan
   * uygulanınca panel birimi = mağaza adedi × bundleQty olmalı; aksi halde 2'lik pakette
   * müşteriye yarım teslimat yapılır.
   *
   * KRİTİK (yarış): sipariş bazlı advisory-lock, iade (revokeOrderForSite) / İnceleme
   * onay-red (releaseHeld/rejectHeld) yollarıyla AYNI anahtarı (hashtext(orderId)) kullanır →
   * bu yollarla serileşir. Kilit edinim sırası da onlarla aynıdır (advisory → satır → sipariş),
   * ABBA deadlock üretmez. Satır FOR UPDATE ile yeniden okunur (TOCTOU): bu arada başka bir
   * çözüm/teslimat/iade araya girmişse satıra DOKUNULMAZ.
   */
  private async linkLine(
    lineId: string,
    orderId: string,
    mapping: { productId: string; bundleQty: number; productName: string | null },
    actor: string,
    ctx: {
      remoteProductId: string | null;
      remoteVariationId: string | null;
      remoteName: string | null;
    },
  ): Promise<{ ok: true; qtyBefore: number; qtyAfter: number } | { ok: false; message: string }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orderId}))`);

      const [line] = await tx
        .select()
        .from(orderLines)
        .where(eq(orderLines.id, lineId))
        .limit(1)
        .for('update');
      if (!line) return { ok: false as const, message: 'Satır bulunamadı (silinmiş olabilir).' };
      if (line.productId) {
        return {
          ok: false as const,
          message: 'Satır bu arada eşlendi (başka bir işlem çözmüş) — tekrar çözüme gerek yok.',
        };
      }
      if (line.canceled) {
        return {
          ok: false as const,
          message: 'Satır iade/iptal edilmiş — yeniden teslim edilmez (§2).',
        };
      }
      if (line.status === 'fulfilled') {
        return { ok: false as const, message: 'Satır zaten tamamlanmış.' };
      }
      // Eşlemesiz satırda atama olamaz; fulfilled_qty > 0 ise veri beklenmedik → GÜVENLİ tarafta
      // kal, dokunma (qty ölçeklemesi teslim edilmiş birimle tutarsız kalabilirdi).
      if (line.fulfilledQty !== 0) {
        return {
          ok: false as const,
          message: `Satırda ürün eşlemesi yokken ${line.fulfilledQty} birim teslim görünüyor — güvenlik gereği elle incelenmeli.`,
        };
      }

      const qtyBefore = line.qty;
      const qtyAfter = qtyBefore * mapping.bundleQty;
      await tx
        .update(orderLines)
        .set({
          productId: mapping.productId,
          qty: qtyAfter,
          // Ölçeği SATIRA sabitle (0025): bundan sonra iade/resync yolları qty'yi canlı
          // eşlemeden değil buradan okur → eşleme sonradan pasifleştirilse/silinse bile bu
          // siparişin birim uzayı kaymaz (aksi halde "aşırı teslim" sanılıp canlı anahtarlar
          // geri alınırdı) ve qty ikinci kez ölçeklenemez (çift-ölçekleme kapandı).
          bundleQty: mapping.bundleQty,
        })
        .where(eq(orderLines.id, lineId));

      // Sipariş durumu 'unmapped' kalmasın (recompute 'unmapped' üretmez; satır artık eşli).
      await recomputeOrderStatus(tx, orderId);

      await tx.insert(fulfillmentEvents).values({
        orderId,
        type: 'mapping_resolved',
        message: `Eşleme geriye dönük uygulandı: ${
          ctx.remoteName ?? ctx.remoteProductId ?? 'mağaza ürünü'
        } → ${mapping.productName ?? mapping.productId}${
          qtyAfter !== qtyBefore
            ? ` (adet ${qtyBefore} → ${qtyAfter}, paket ×${mapping.bundleQty})`
            : ''
        } — ${actor}`,
        meta: {
          op: 'pending_resolve',
          lineId,
          productId: mapping.productId,
          bundleQty: mapping.bundleQty,
          remoteProductId: ctx.remoteProductId,
          remoteVariationId: ctx.remoteVariationId,
          qtyBefore,
          qtyAfter,
        },
      });

      // audit_action enum'una YENİ değer eklenmedi (migration yazılamaz) → mevcut 'assign'
      // kullanılır; ayrım meta.op = 'pending_resolve' ile yapılır (releaseHeld deseni).
      await tx.insert(auditLog).values({
        action: 'assign',
        actor,
        targetType: 'order_line',
        targetId: lineId,
        meta: {
          op: 'pending_resolve',
          orderId,
          productId: mapping.productId,
          remoteProductId: ctx.remoteProductId,
          remoteVariationId: ctx.remoteVariationId,
          bundleQty: mapping.bundleQty,
          qtyBefore,
          qtyAfter,
        },
      });

      return { ok: true as const, qtyBefore, qtyAfter };
    });
  }
}
