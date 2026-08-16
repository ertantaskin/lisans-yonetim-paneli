import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { notExpiredCond } from '../assignment/assign';

/** Genel-bakış son sipariş satırı (özet — sır/payload YOK). */
export interface DashboardRecentOrder {
  id: string;
  remoteOrderId: string;
  customerEmail: string;
  status: string;
  createdAt: string;
}

// ─── İş istasyonu ("canlı") akışı (§13/§17) ────────────────────────────────────────────
// Panel mesai boyunca AÇIK kalacak bir iş istasyonu ekranı besler. N ayrı poller yerine TEK
// hafif uç: aynı anlık görüntüde son siparişler + son destek talepleri + bildirim çanı + KPI.
// Sır/payload ASLA dönmez (yalnız kimlik/durum/sayaç metinleri).

/** Canlı akış: son sipariş satırı (özet — payload/anahtar YOK). */
export interface LiveOrderRow {
  id: string;
  remoteOrderId: string;
  siteId: string;
  /**
   * Sipariş sahibi mağazanın alan adı. orders.site_id FK'si ON DELETE RESTRICT olduğundan
   * siparişi olan site SİLİNEMEZ → pratikte hep dolu; join savunma amaçlı LEFT (yalnız
   * teorik boşlukta '' döner, UI tarafı nullable ile uğraşmaz).
   */
  siteDomain: string;
  customerEmail: string;
  status: string;
  /** §8 inceleme kuyruğunda mı (held_for_review) — teslimat manuel onay bekliyor. */
  held: boolean;
  /**
   * Siparişin EŞLEMESİ OLMAYAN aktif satırı var mı (operatör /mappings'te eşleme kurmalı).
   *
   * Yüklem admin-orders.pending() ile BİREBİR AYNIDIR (ürün bağlanmamış + iptal DEĞİL + satır
   * durumu pending/partial) → canlı akış ile Bekleyen Teslimatlar ekranı aynı siparişi farklı
   * işaretlemez. Sipariş `status` alanına BAKILMAZ: kısmen teslim edilmiş karma siparişte
   * status 'partial' olur ama satırlardan biri hâlâ eşlemesiz olabilir.
   */
  hasUnmappedLine: boolean;
  lineCount: number;
  fulfilledLines: number;
  createdAt: string;
}

/** Canlı akış: son destek/değişim talebi satırı (talep gerekçesi KIRPILIR). */
export interface LiveSupportRow {
  id: string;
  status: string;
  customerEmail: string;
  orderId: string;
  remoteOrderId: string | null;
  siteDomain: string | null;
  /** Talebin ilk ~140 karakteri (uzunsa '…' eklenir) — liste satırına sığsın. */
  reasonExcerpt: string;
  withinWarranty: boolean;
  createdAt: string;
}

/** Canlı akış: bildirim çanı satırı (readAt null = okunmamış). */
export interface LiveNotificationRow {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  createdAt: string;
  readAt: string | null;
}

/** Canlı akış: üst şerit sayaçları (hepsi TEK sorguda toplanır). */
export interface LiveStats {
  /** Açık destek/değişim talebi (open + info_requested). */
  openSupport: number;
  /** İnceleme kuyruğundaki sipariş (held_for_review = true). */
  heldOrders: number;
  /** Eşlemesi OLAN ama teslim bekleyen satır (stok bekliyor). */
  pendingLines: number;
  /** Eşlemesi OLMAYAN bekleyen satır (operatör eşleme yapmalı). */
  unmappedLines: number;
  /**
   * EŞLEMESİZ satırı olan SİPARİŞ sayısı (bkz. UNMAPPED_ORDERS_COUNT). Satır sayacından
   * (unmappedLines) FARKLI bir soruyu yanıtlar: "kaç müşteri siparişi eşleme beklediği için
   * (kısmen ya da tamamen) teslim edilemiyor". GERÇEK talebi ölçen tek sayaç budur →
   * operatör uyarısı/alarmı YALNIZ buradan türetilir; operatör /mappings ekranından eşlemeyi
   * kurup satırları çözünce KENDİLİĞİNDEN söner.
   */
  unmappedOrders: number;
  /**
   * Mağaza katalogunda (site_remote_products) olup o site için AKTİF eşlemesi OLMAYAN ürün
   * sayısı.
   *
   * BU BİR ALARM DEĞİLDİR — BİLGİ sayacıdır. Katalog mağazanın TÜM yayınlanmış ürünlerini
   * taşır (lisans olmayanlar dahil): "eşlenmemiş" ≠ "eşlenmesi gereken". 500 ürünlü bir
   * mağazada bu sayı kalıcı olarak yüksek kalır ve hiçbir doğru işlemle sıfırlanmaz.
   * Kırmızı/destructive uyarı ASLA bundan türetilmez (alarm körlüğü yaratır, üstelik
   * operatörü tehlikeli "her şeyi eşle" refleksine iter, §3); yalnız /mappings ekranına
   * yönlendiren nötr bir bilgi olarak gösterilir. ≤60 sn bayat olabilir
   * (bkz. COUNTER_CACHE_TTL_MS) — bilgi sayacı olduğu için bilinçli.
   */
  unmappedCatalogProducts: number;
  /**
   * Düşük stok ürünü sayısı (summary().lowStockCount ile AYNI tanım — aynı önbelleği
   * paylaşırlar). ≤60 sn bayat olabilir (bkz. COUNTER_CACHE_TTL_MS); uyarı sayacı
   * olduğu için bilinçli.
   */
  lowStockProducts: number;
}

/** Tek çağrılık iş istasyonu anlık görüntüsü. */
export interface LiveSnapshot {
  /** Sunucu zamanı (ISO). ETag hesabına DAHİL DEĞİL — yoksa her istek değişirdi. */
  ts: string;
  orders: LiveOrderRow[];
  supports: LiveSupportRow[];
  notifications: { unread: number; recent: LiveNotificationRow[] };
  stats: LiveStats;
}

/** Canlı uç varsayılan/limit sınırları — yanıt küçük kalsın (poll sıcak yolu). */
const LIVE_DEFAULT_LIMIT = 15;
const LIVE_MAX_LIMIT = 50;
/** Destek talebi gerekçesinin listede gösterilen azami uzunluğu. */
const REASON_EXCERPT_LEN = 140;

/**
 * AĞIR uyarı sayaçlarının SÜREÇ-İÇİ önbellek ömrü (ms). İki sayaç paylaşır: düşük stok
 * (products × license_items agregasyonu) ve eşlenmemiş katalog ürünü (site_remote_products ×
 * site_product_mappings NOT EXISTS taraması).
 *
 * NEDEN önbellek: bunlar canlı anlık görüntünün EN pahalı parçalarıdır (diğer sorgular
 * nokta-index'lidir). Panel mesai boyunca AÇIK kalan bir iş istasyonudur ve her sekme 15
 * sn'de bir poll eder → 3 sekme = dakikada 12 agregasyon. Bu uyarılar DAKİKALAR ölçeğinde
 * anlamlıdır (saniyeler değil), dolayısıyla ≤60 sn bayatlık kabul edilebilir ve yük
 * "sekme sayısı × 4/dk" yerine "dakikada EN FAZLA 1"e iner.
 *
 * NEDEN 60 sn: poll periyodunun (15 sn) tam katı → her 4 poll'da bir tazelenir; ETag de
 * bu yüzden gereksiz yere flap etmez (aradaki 3 poll'da sayaç sabit → 304 korunur).
 *
 * BİLİNÇLİ TAKAS: önbellek süreç-içidir; çok-örnekli dağıtımda örnekler arası kısa süreli
 * sapma görülebilir. Kabul edilebilir çünkü bunlar YALNIZ uyarı sayaçlarıdır — teslimat/atama
 * kararları buna dayanmaz (gerçek düşük-stok alarmı ayrı cron'dan, low-stock.service'ten
 * üretilir; eşleme ise HER ZAMAN elle yapılır — sayaç yalnız operatörü uyarır).
 */
const COUNTER_CACHE_TTL_MS = 60_000;

/**
 * Eşlenmemiş sipariş sayacının TEK KAYNAK tanımı (canlı şerit + genel-bakış aynı SQL'i
 * kullanır → iki ekran farklı sayı gösterip "hangisi doğru" sorusu doğmaz).
 *
 * TANIM (bu dalgada DEĞİŞTİ): "en az bir EŞLEMESİZ AKTİF satırı olan sipariş" sayısı.
 *
 * NEDEN değişti — eski tanım (`orders.status = 'unmapped'`) sessizce eksik sayıyordu:
 *  - `status='unmapped'` YALNIZ createOrder'da ve ancak satırların HEPSİ eşlemesizse yazılır;
 *    recomputeOrderStatus bu değeri HİÇ üretmez. 2 kalemli bir siparişte (biri eşli-stok
 *    bekliyor, biri EŞLEMESİZ) sipariş 'pending' olur → sayaca HİÇ girmezdi. Operatörün
 *    "eşlenmemiş sipariş fark edilmiyor" şikâyeti tam olarak buydu.
 *  - Satırlardan biri çözülünce sipariş 'partial'a geçip sayaçtan KALICI düşerdi (kalan
 *    eşlemesiz satır hâlâ beklerken).
 * Satır-tabanlı tanım iki boşluğu da kapatır ve pending-lines.service.summary()'nin tekil
 * sipariş sayımıyla BİREBİR aynı SQL'dir → /mappings ekranındaki "N sipariş bekliyor" ile
 * üst şerit sayacı asla çelişmez.
 *
 * PERF: koşul `order_lines_pending_fifo_idx` KISMİ index'inin YÜKLEMİYLE örtüşür
 * (WHERE status IN ('pending','partial') AND canceled = false). NOT: bu index'in kolonları
 * (product_id, priority DESC, created_at) sayımın ihtiyaç duyduğundan fazladır — örtüşme
 * SIRALAMADA değil yalnız KISMİ YÜKLEMDE tamdır; kazanç "yalnız iş bekleyen küçük alt küme
 * taranır"dan gelir. (Eski yorum artık VAR OLMAYAN `order_lines_pending_product_idx`e
 * dayanıyordu — migration 0042 onu DÜŞÜRDÜ; ön eki ve kısmi koşulu aynı olduğu için
 * yeni index onun karşıladığı planları da karşılar, bkz. schema/orders.ts.)
 * Eski sorgunun taradığı `orders.status` için o tarihte ADANMIŞ index YOKTU (seq scan) —
 * yani bu değişiklik doğruluğu düzeltirken poll sıcak yolunu da ucuzlatmıştı; bugün
 * `orders_open_status_idx` (0042) o eksiği de kapatıyor.
 *
 * İptal (canceled) satır DIŞARIDA: iade/iptal edilmiş satır asla teslim edilmez (§2), operatörden
 * eşleme beklemez.
 */
const UNMAPPED_ORDERS_COUNT = sql`(
  SELECT count(DISTINCT ol.order_id)::int
  FROM order_lines ol
  WHERE ol.product_id IS NULL
    AND ol.canceled = false
    AND ol.status IN ('pending', 'partial')
)`;

/**
 * Süreç-içi sayaç önbellek yuvası: değer (henüz hesaplanmadıysa null), yazılma anı ve
 * SÜREN hesap. `inflight` NEDEN: önbellek boşken aynı anda gelen N poll (çok sekme) aksi
 * halde N ayrı ağır sorgu başlatırdı — "sürü etkisi" tam da kaçındığımız yükü geri
 * getirirdi. Bekleyenler tek sorgunun sonucunu paylaşır.
 */
interface CounterCacheSlot {
  value: number | null;
  at: number;
  inflight: Promise<number> | null;
}

/** pg timestamptz (Date | string) → ISO. postgres.js Date döndürür; string de tolere edilir. */
function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

/**
 * Panel genel-bakış özeti (§13). Tümü mevcut tablolardan salt-okunur agregasyon;
 * yeni tablo/migration yok. KPI'lar tek doğruluk kaynağından (panel) türetilir.
 */
export interface DashboardSummary {
  /**
   * EŞLEMESİ OLAN ve teslim bekleyen sipariş satırı (stok bekliyor).
   *
   * TANIM DÜZELTİLDİ: eskiden düz `status IN ('pending','partial')` sayılıyordu → (a) İPTAL
   * (canceled) satırlar da sayılıyordu; iade/iptal edilmiş satır ASLA teslim edilmez (§2), yani
   * sayaç kalıcı olarak şişip hiçbir doğru işlemle sıfırlanmıyordu, (b) eşlemesiz (product_id
   * NULL) satırlar da bu kovaya giriyordu → genel-bakış "bekleyen" sayısı, canlı şeridin
   * pendingLines/unmappedLines ayrımıyla çelişiyordu (operatör "hangisi doğru" diye soruyordu).
   * Artık canlı şeritle AYNI yüklem ve AYNI yüklemeden (liveCounters) gelir.
   */
  pendingLines: number;
  /**
   * EŞLEMESİ OLMAYAN bekleyen satır (operatör /mappings'te eşleme kurmalı) — canlı şeritteki
   * `unmappedLines` ile AYNI değer (aynı sorgudan okunur).
   */
  unmappedLines: number;
  /** Bugün (yerel gün başı, sunucu TZ) oluşturulan sipariş sayısı. */
  todayOrders: number;
  /**
   * EŞLEMESİZ satırı olan sipariş sayısı — canlı şeritle AYNI tanım/SQL
   * (bkz. UNMAPPED_ORDERS_COUNT). Operatör uyarısı YALNIZ bu sayaçtan türetilir.
   */
  unmappedOrders: number;
  /**
   * Mağaza katalogunda olup AKTİF eşlemesi olmayan ürün sayısı — canlı şeritle AYNI
   * önbelleği paylaşır (≤60 sn bayat olabilir, bkz. COUNTER_CACHE_TTL_MS).
   * ALARM DEĞİL, BİLGİ sayacıdır (gerekçe: LiveStats.unmappedCatalogProducts).
   */
  unmappedCatalogProducts: number;
  /**
   * Düşük stok ürünü sayısı (low_stock_threshold IS NOT NULL AND available<=eşik).
   * ≤60 sn önbellekli (COUNTER_CACHE_TTL_MS) — canlı uçla aynı değer.
   */
  lowStockCount: number;
  /** Açık değişim talebi (status IN open|info_requested). */
  openReplacements: number;
  /** Açık güvenlik olayı — son 7 gün penceresi (security_events'te resolved kolonu yok). */
  openSecurityEvents: number;
  /** Toplam anlık atanabilir stok (products.service.list ile aynı mantık). */
  totalAvailableStock: number;
  /** En yeni 5 sipariş (özet). */
  recentOrders: DashboardRecentOrder[];
}

/**
 * Genel-bakış (dashboard) servisi (§13) — salt-okunur agregasyon. Hiçbir yazma/yan
 * etki yapmaz; KPI blokları paralel toplanır. low_stock eşiği W1 ürün detayıyla aynı
 * tanım (products.low_stock_threshold); güvenlik olayları SecurityService ile aynı tablo.
 */
@Injectable()
export class DashboardService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Düşük-stok sayacı önbelleği (bkz. COUNTER_CACHE_TTL_MS). Servis singleton olduğu
   * için alan süreç ömrü boyunca yaşar; kalıcılık/invalidasyon YOKTUR (TTL yeter).
   */
  private lowStockSlot: CounterCacheSlot = { value: null, at: 0, inflight: null };
  /**
   * Eşlenmemiş katalog ürünü sayacı önbelleği — düşük-stokla AYNI desen, AYRI yuva
   * (biri tazelenirken diğeri gereksiz yere geçersizleşmesin).
   */
  private unmappedCatalogSlot: CounterCacheSlot = { value: null, at: 0, inflight: null };

  /**
   * Ağır bir sayacı önbellekten servis eder; TTL dolduysa TEK sorgu koşup tazeler
   * (eşzamanlı çağrılar aynı hesabı paylaşır — bkz. CounterCacheSlot.inflight).
   * Hata durumunda bayat değere DÜŞÜLMEZ — hata çağırana yansır (önceki davranış korunur).
   */
  private async counterCached(
    slot: CounterCacheSlot,
    load: () => Promise<number>,
  ): Promise<number> {
    if (slot.value !== null && Date.now() - slot.at < COUNTER_CACHE_TTL_MS) return slot.value;
    if (slot.inflight) return slot.inflight;

    const run = load()
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

  /** Düşük-stok sayacı (60 sn önbellekli + tek-uçuş). */
  private lowStockCountCached(): Promise<number> {
    return this.counterCached(this.lowStockSlot, () => this.lowStockCount());
  }

  /** Eşlenmemiş katalog ürünü sayacı (60 sn önbellekli + tek-uçuş). */
  private unmappedCatalogProductsCached(): Promise<number> {
    return this.counterCached(this.unmappedCatalogSlot, () => this.unmappedCatalogProducts());
  }

  /**
   * Tüm KPI bloklarını paralel toplayıp tek özet nesnesi döndürür.
   *
   * TUTARLILIK: satır/talep sayaçları canlı şeritle AYNI yüklemeden (liveCounters) gelir —
   * genel-bakış, canlı iş istasyonu ve /mappings ekranı ARTIK çelişemez (üçü de tek SQL
   * tanımını paylaşır). Eskiden burada ayrı, YÜKLEMİ FARKLI (iptal/eşlemesiz satırları da
   * sayan) sorgular vardı.
   */
  async summary(): Promise<DashboardSummary> {
    const [
      counters,
      todayOrders,
      unmappedCatalogProducts,
      lowStockCount,
      openSecurityEvents,
      totalAvailableStock,
      recentOrders,
    ] = await Promise.all([
      // pendingLines + unmappedLines + unmappedOrders + openSupport TEK sorguda (canlı ile ortak).
      this.liveCounters(),
      this.todayOrders(),
      // Canlı uçla AYNI önbellek (aşağıdaki lowStock ile aynı gerekçe).
      this.unmappedCatalogProductsCached(),
      // Canlı uçla AYNI önbelleği paylaşır → genel-bakış ile canlı şerit aynı sayıyı gösterir
      // (iki ayrı hesap iki farklı değer üretip "sayı zıplıyor" izlenimi vermesin).
      this.lowStockCountCached(),
      this.openSecurityEvents(),
      this.totalAvailableStock(),
      this.recentOrders(),
    ]);
    return {
      pendingLines: counters.pendingLines,
      unmappedLines: counters.unmappedLines,
      todayOrders,
      unmappedOrders: counters.unmappedOrders,
      unmappedCatalogProducts,
      lowStockCount,
      // Canlı şeritteki "açık destek" ile AYNI tanım (open + info_requested) — tek sorgudan.
      openReplacements: counters.openSupport,
      openSecurityEvents,
      totalAvailableStock,
      recentOrders,
    };
  }

  /**
   * Mağaza katalogunda olup AKTİF eşlemesi OLMAYAN ürün sayısı (§3).
   *
   * ⚠ BU SAYAÇ BİR ALARM DEĞİLDİR — /mappings ekranına yönlendiren BİLGİ sayacıdır.
   * Katalog, mağazanın TÜM yayınlanmış ürünlerinin anlık görüntüsüdür: lisans satmayan
   * ürünler de (kargo, fiziksel ürün, hizmet…) içindedir. Yani "eşlenmemiş" ≠ "eşlenmesi
   * gereken" ve bu sayı doğru çalışan bir mağazada da kalıcı olarak yüksek kalır. Kırmızı/
   * destructive uyarı ASLA buradan türetilmemelidir (hiçbir doğru işlemle sönmeyen uyarı =
   * alarm körlüğü; dahası operatörü tehlikeli "catch-all" ürün-seviyesi eşleme kurmaya iter).
   * GERÇEK talep alarmı için `unmappedOrders` (UNMAPPED_ORDERS_COUNT) kullanılır.
   *
   * OTOMATİK EŞLEŞTİRME YOK — bu YALNIZ bir sayaçtır, hiçbir eşleme kurmaz/önermez.
   *
   * EŞLİ/EŞSİZ KARARI products.service.listCatalog ile aynıdır (varyasyon-özel VEYA ürün-seviyesi
   * eşleme; active=false eşleme "eşlenmiş" SAYILMAZ) — orada LEFT JOIN + `mapped_product_id IS NOT
   * NULL`, burada aynı ON koşulunun NOT EXISTS hâli. Eşdeğerdir çünkü site_product_mappings.product_id
   * NOT NULL'dır (eşleşen satır ⇔ mapped=true); yalnız sayı gerektiğinden DISTINCT ON/JOIN yerine ucuz
   * yarı-birleştirme kullanılır (mappings_site_remote_uniq index'inin (site_id, remote_product_id)
   * öneki kullanılır).
   *
   * ⚠ KAPSAM AYNI DEĞİL (bilinçli): bu sayaç varyasyonlu ürünün EBEVEYN satırını HARİÇ tutar,
   * listCatalog ise o satırı LİSTELER (ama `isVariableParent` bayrağıyla işaretler ve UI onu kırmızı
   * "eşlenmemiş" yerine nötr "varyasyonları eşleyin — N/M eşli" olarak gösterir). Yani iki ekran
   * aynı SATIR KÜMESİNİ göstermez; ama hiçbirinde ebeveyn satırı "eşlenmemiş" ALARMI üretmez →
   * operatör "0 eşlenmemiş vs 100 eşlenmemiş" çelişkisi yaşamaz. Bu yorum eskiden "BİREBİR aynı"
   * diyordu; gerçek bu değil — kural şu: EŞLEME KOŞULU birebir aynı, EBEVEYN SATIRI muamelesi farklı
   * (burada sayılmaz, orada nötr bilgi satırı olarak listelenir). Değiştirirken ikisi de güncellenmeli.
   *
   * EBEVEYN SATIRI NEDEN HARİÇ: katalogda variable bir ürün hem EBEVEYN satırı (kind='variable',
   * remote_variation_id IS NULL) hem her varyasyonu (kind='variation') ile durur. Sipariş satırı HER
   * ZAMAN bir varyasyona düşer, eşleme de varyasyon-özel kurulur; ebeveyn satırı ise SQL üç-değerli
   * mantığı gereği varyasyon-özel eşlemelerle ASLA eşleşmez (m.remote_variation_id = NULL → NULL).
   * Sonuç: tüm varyasyonlar eşli olsa bile ebeveyn sonsuza dek "eşlenmemiş" sayılırdı → hariç tutulur.
   *
   * PERF: katalog satırı başına bir index probe → poll başına DEĞİL, 60 sn'de bir koşar
   * (bkz. unmappedCatalogProductsCached / COUNTER_CACHE_TTL_MS).
   */
  private async unmappedCatalogProducts(): Promise<number> {
    const rows = await rawRows<{ c: number }>(this.db, sql`
      SELECT count(*)::int AS c
      FROM site_remote_products rp
      WHERE rp.active = true
        -- Varyasyonlu ürünün EBEVEYN satırı sayılmaz (yukarıdaki gerekçe). coalesce ŞART:
        -- düz "rp.kind = 'variable'" yazımında, kind NULL olan ESKİ katalog satırlarında ifade
        -- NULL üretir, NOT(NULL) da NULL olur → o satırlar sessizce sayımdan düşerdi.
        AND NOT (coalesce(rp.kind, '') = 'variable' AND rp.remote_variation_id IS NULL)
        AND NOT EXISTS (
          SELECT 1
          FROM site_product_mappings m
          WHERE m.site_id = rp.site_id
            AND m.remote_product_id = rp.remote_product_id
            AND m.active = true
            AND (m.remote_variation_id IS NULL OR m.remote_variation_id = rp.remote_variation_id)
        );
    `);
    return Number(rows[0]?.c ?? 0);
  }

  // NOT: "bekleyen satır" ve "açık destek talebi" sayaçları ARTIK burada AYRI sorgu değildir —
  // liveCounters() içinde, canlı şeritle AYNI yüklemle toplanır (bkz. summary()). Ayrı tutuldukları
  // sürece yüklemler sessizce ayrışıyordu (iptal/eşlemesiz satır farkı) ve iki ekran çelişiyordu.

  /** Bugün (gün başından itibaren) oluşturulan sipariş sayısı. */
  private async todayOrders(): Promise<number> {
    const rows = await rawRows<{ c: number }>(this.db, sql`
      SELECT count(*)::int AS c
      FROM orders
      WHERE created_at >= date_trunc('day', now());
    `);
    return Number(rows[0]?.c ?? 0);
  }

  /**
   * Düşük stok ürünü sayısı. available = status='available' VE stok ömrü DOLMAMIŞ
   * license_item'ların (max_uses - use_count) toplamı (products.service.list ile aynı).
   * Yalnız eşiği TANIMLI ürünler (IS NOT NULL) değerlendirilir; available <= eşik olanlar sayılır.
   */
  private async lowStockCount(): Promise<number> {
    // PERF: ürün-başına korele skalar alt-sorgu (her ürün için ayrı SELECT sum) yerine TEK geçiş —
    // LEFT JOIN license_items + GROUP BY + HAVING (low-stock.service.checkLowStock ile aynı desen).
    // GROUP BY p.id (PK) → HAVING içinde p.low_stock_threshold'a erişilebilir.
    //
    // PERF (kritik): status süzgeci BİLEREK JOIN koşulundadır, HAVING'deki FILTER'da DEĞİL.
    // `license_items_available_idx` KISMİ bir index'tir (WHERE status='available'); süzgeç
    // yalnız agregat FILTER'ında kalırsa planlayıcı tabloyu daraltamaz ve TÜM license_items'ı
    // taramak zorunda kalır. Koşul JOIN'e taşındığında ise inner ilişki üzerinde bir kısıt
    // olur → kısmi index kullanılabilir hâle gelir (canlı poll'daki 15 sn'de bir tam tarama biter).
    //
    // ANLAM DEĞİŞMEZ: LEFT JOIN olduğu için eşleşen 'available' satırı OLMAYAN ürün de listede
    // kalır (li.* NULL → sum NULL → coalesce 0 ≤ eşik → düşük stok sayılır, eskisi gibi).
    // available = Σ(max_uses − use_count) KAPASİTE mantığı (MAK/multi) aynen korunur.
    //
    // notExpiredCond('li'): stok ömrü (expires_at) DOLMUŞ kalem atama sorgusunda (assign.ts)
    // ZATEN dışlanır — burada sayılırsa alarm GEÇ kalır (panel "eşiğin üstündesin" der, gerçekte
    // atanabilir stok yoktur). Koşulun TEK KAYNAĞI assignment/assign.ts; JOIN ON'da kalması
    // kısmi index kullanımını da bozmaz (yalnız ek bir satır süzgeci).
    const rows = await rawRows<{ c: number }>(this.db, sql`
      SELECT count(*)::int AS c
      FROM (
        SELECT p.id
        FROM products p
        LEFT JOIN license_items li
          ON li.product_id = p.id
         AND li.status = 'available'
         AND ${notExpiredCond('li')}
        WHERE p.low_stock_threshold IS NOT NULL
        GROUP BY p.id
        HAVING coalesce(sum(li.max_uses - li.use_count), 0) <= p.low_stock_threshold
      ) t;
    `);
    return Number(rows[0]?.c ?? 0);
  }

  /**
   * Açık güvenlik olayı. security_events'te çözüldü/kapatıldı kolonu YOK (§15: kayıt
   * yüzeye çıkar, aksiyon insanda); bu yüzden "açık" = son 7 gün penceresindeki olaylar.
   */
  private async openSecurityEvents(): Promise<number> {
    const rows = await rawRows<{ c: number }>(this.db, sql`
      SELECT count(*)::int AS c
      FROM security_events
      WHERE created_at >= now() - interval '7 days';
    `);
    return Number(rows[0]?.c ?? 0);
  }

  /**
   * Toplam anlık atanabilir stok (available kapasite toplamı).
   *
   * notExpiredCond(): stok ömrü dolmuş kalem atanamaz (assign.ts aynı koşulu uygular) →
   * genel-bakış KPI'ı "var olmayan stok" göstermesin. Alias verilmedi: tablo sorguda
   * takma adsız `license_items` olarak geçiyor.
   */
  private async totalAvailableStock(): Promise<number> {
    const rows = await rawRows<{ total: number }>(this.db, sql`
      SELECT coalesce(sum(max_uses - use_count), 0)::int AS total
      FROM license_items
      WHERE status = 'available'
        AND ${notExpiredCond()};
    `);
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * En yeni 5 sipariş (özet satır — sır/payload dönmez).
   *
   * TIE-BREAK (`id DESC`) EKLENDİ (denetim R11): aynı dosyadaki üç canlı-akış sorgusu
   * (liveOrders/liveSupports/liveNotifications) tie-break taşırken bu LIMIT'li sıralama
   * taşımıyordu. Toplu push (tek transaction'da yazılan siparişler) BİREBİR aynı
   * `created_at` damgasını taşır → 5'inci sıradaki sipariş art arda iki yüklemede
   * DEĞİŞEBİLİYORDU (aynı veri, farklı liste).
   */
  private async recentOrders(): Promise<DashboardRecentOrder[]> {
    const list = await rawRows<{
      id: string;
      remote_order_id: string;
      customer_email: string;
      status: string;
      created_at: string;
    }>(this.db, sql`
      SELECT id, remote_order_id, customer_email, status, created_at
      FROM orders
      ORDER BY created_at DESC, id DESC
      LIMIT 5;
    `);
    return list.map((r) => ({
      id: r.id,
      remoteOrderId: r.remote_order_id,
      customerEmail: r.customer_email,
      status: r.status,
      // pg timestamptz → ISO (Date ile normalize; string/Date ikisini de karşılar).
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  // ─── İş istasyonu ("canlı") akışı ────────────────────────────────────────────────────

  /**
   * Tek çağrılık iş istasyonu anlık görüntüsü (§13/§17). Ekran mesai boyunca açık kalıp
   * ~15 sn'de bir çağrılacağı için TASARIM GEREĞİ ucuzdur:
   *  - toplam 6 sorgu (N ayrı poller yerine tek uç; sayaçlar TEK sorguda toplanır),
   *  - sıcak yoldaki liste ve sayaç sorguları index'ten karşılanır (orders_created_idx /
   *    order_lines_order_idx / notifications_created_idx / notifications_unread_idx /
   *    orders_held_idx / order_lines_pending_fifo_idx / replacement_requests_created_idx).
   *    DÜRÜST İSTİSNALAR: (a) açık destek sayacı `replacement_requests_status_idx`'i ancak
   *    seçicilik yeterliyse kullanır, (b) eşlemesiz SİPARİŞ sayacı kısmi index'ten okunur ama
   *    tekilleştirme (count DISTINCT order_id) için satır başına heap erişimi gerektirir —
   *    yine de eski `orders.status='unmapped'` sürümünden ucuzdur (orada index YOKTU, tam
   *    tablo taranıyordu), (c) aşağıdaki iki AĞIR blok tam taramadır ve bu yüzden önbelleklidir,
   *  - iki AĞIR blok (düşük-stok agregasyonu + eşlenmemiş katalog taraması) 60 sn
   *    önbelleklidir (COUNTER_CACHE_TTL_MS) → poll başına DEĞİL, dakikada en fazla bir kez koşar,
   *  - yanıt limit ile küçük tutulur (max 50),
   *  - `etag` ile değişiklik yoksa controller 304 döner → günün büyük kısmında bant genişliği ~0.
   *
   * ETag `ts` HARİÇ tüm gövdeden türetilir; aksi halde her istek "değişti" görünürdü.
   * @returns gövde (`snapshot`) + zayıf ETag (`etag`)
   */
  async live(limit = LIVE_DEFAULT_LIMIT): Promise<{ snapshot: LiveSnapshot; etag: string }> {
    const n =
      Number.isFinite(limit) && limit > 0
        ? Math.min(Math.trunc(limit), LIVE_MAX_LIMIT)
        : LIVE_DEFAULT_LIMIT;

    const [
      orders,
      supports,
      recentNotifications,
      unread,
      counters,
      lowStockProducts,
      unmappedCatalogProducts,
    ] = await Promise.all([
      this.liveOrders(n),
      this.liveSupports(n),
      this.liveNotifications(n),
      this.unreadNotificationCount(),
      this.liveCounters(),
      // Poll sıcak yolunun "ağır" sorguları → 60 sn önbellekten (bkz. COUNTER_CACHE_TTL_MS).
      this.lowStockCountCached(),
      this.unmappedCatalogProductsCached(),
    ]);

    const snapshot: LiveSnapshot = {
      ts: new Date().toISOString(),
      orders,
      supports,
      notifications: { unread, recent: recentNotifications },
      // Anahtar sırası SABİT (spread + iki sabit alan) → JSON.stringify deterministik kalır,
      // ETag veri değişmeden flap etmez.
      stats: { ...counters, lowStockProducts, unmappedCatalogProducts },
    };

    // Deterministik özet: `ts` DIŞARIDA bırakılır. Nesneler sabit anahtar sırasıyla
    // kurulduğundan JSON.stringify çıktısı da deterministiktir (aynı veri → aynı ETag).
    const digest = createHash('sha1')
      .update(
        JSON.stringify({
          orders: snapshot.orders,
          supports: snapshot.supports,
          notifications: snapshot.notifications,
          stats: snapshot.stats,
        }),
      )
      .digest('hex');

    return { snapshot, etag: `W/"${digest}"` };
  }

  /**
   * En yeni N sipariş + mağaza alan adı + satır sayaçları. Önce orders_created_idx ile
   * yalnız N satır seçilir, sonra LATERAL ile o N sipariş için satır agregasyonu yapılır
   * → tüm order_lines taranmaz (poll sıcak yolu ucuz kalır).
   *
   * `has_unmapped_line` AYNI LATERAL bloğunda üretilir (ek sorgu/N+1 YOK): sayaçlar zaten o
   * siparişin satırlarını okuyor. Yüklem admin-orders.pending() ile birebir aynı olmalıdır —
   * iki ekran aynı siparişi farklı işaretlemesin (bkz. LiveOrderRow.hasUnmappedLine).
   */
  private async liveOrders(limit: number): Promise<LiveOrderRow[]> {
    const rows = await rawRows<{
      id: string;
      remote_order_id: string;
      site_id: string;
      site_domain: string | null;
      customer_email: string;
      status: string;
      held_for_review: boolean;
      has_unmapped_line: boolean;
      line_count: number;
      fulfilled_lines: number;
      created_at: Date | string;
    }>(this.db, sql`
      SELECT o.id,
             o.remote_order_id,
             o.site_id,
             s.domain AS site_domain,
             o.customer_email,
             o.status::text AS status,
             o.held_for_review,
             coalesce(l.has_unmapped_line, false) AS has_unmapped_line,
             coalesce(l.line_count, 0) AS line_count,
             coalesce(l.fulfilled_lines, 0) AS fulfilled_lines,
             o.created_at
      FROM (
        SELECT id, remote_order_id, site_id, customer_email, status, held_for_review, created_at
        FROM orders
        -- id tiebreak: aynı ms'de oluşan iki sipariş poll'lar arasında YER DEĞİŞTİRMESİN.
        -- Sıra kararsız olsaydı veri değişmeden ETag değişir, 304 kazanımı kaybolurdu.
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      ) o
      LEFT JOIN sites s ON s.id = o.site_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS line_count,
               (count(*) FILTER (WHERE ol.status = 'fulfilled'))::int AS fulfilled_lines,
               -- admin-orders.pending() ile BİREBİR aynı yüklem: ürün bağlanmamış (product_id
               -- NULL) + iptal DEĞİL + satır hâlâ iş bekliyor (pending/partial).
               bool_or(
                 ol.product_id IS NULL
                 AND ol.canceled = false
                 AND ol.status IN ('pending', 'partial')
               ) AS has_unmapped_line
        FROM order_lines ol
        WHERE ol.order_id = o.id
      ) l ON true
      ORDER BY o.created_at DESC, o.id DESC;
    `);

    // Anahtar sırası SABİT (ETag determinizmi) — yeni alan sona değil, tip sırasına göre eklenir.
    return rows.map((r) => ({
      id: r.id,
      remoteOrderId: r.remote_order_id,
      siteId: r.site_id,
      siteDomain: r.site_domain ?? '',
      customerEmail: r.customer_email,
      status: r.status,
      held: r.held_for_review === true,
      hasUnmappedLine: r.has_unmapped_line === true,
      lineCount: Number(r.line_count ?? 0),
      fulfilledLines: Number(r.fulfilled_lines ?? 0),
      createdAt: toIso(r.created_at),
    }));
  }

  /**
   * En yeni N destek/değişim talebi. Gerekçe SQL'de kırpılır (uzun serbest metin ağı
   * gereksiz meşgul etmesin); kırpıldıysa '…' eklenir. Sır dönmez (payload/anahtar yok).
   *
   * PERF: sıralama+limit, JOIN'lerden ÖNCE tek tabloda (liveOrders ile aynı desen). Düz
   * yazımda planlayıcı önce orders/sites ile birleştirip SONRA tüm sonucu sıralayabiliyordu
   * (talep sayısı büyüdükçe her poll'da tam tarama + sort). Alt sorgu `ORDER BY created_at
   * DESC, id DESC LIMIT n` ile `replacement_requests_created_idx`'ten yalnız N satır okur;
   * gerekçe kırpması da içeride yapılır → uzun serbest metin dışarı hiç taşınmaz.
   *
   * STATÜ SÜZGECİ YOK (bilinçli): kart "Son Destek Talepleri"dir, açık kuyruk DEĞİL —
   * tüketici (admin live-feed) `approved`/`rejected` rozetlerini de render eder, yani
   * kapanan talebin akışta görünmesi beklenen davranıştır. Açık kuyruk sayısı zaten AYRI
   * gelir (`liveCounters.open_support` + /support ekranı). Süzgeç eklemek ekranın anlamını
   * değiştirirdi; index seçiciliği için gerekli de değil (sıralama zaten index'ten karşılanıyor).
   */
  private async liveSupports(limit: number): Promise<LiveSupportRow[]> {
    const rows = await rawRows<{
      id: string;
      status: string;
      customer_email: string;
      order_id: string;
      remote_order_id: string | null;
      site_domain: string | null;
      reason_excerpt: string | null;
      reason_len: number;
      within_warranty: boolean;
      created_at: Date | string;
    }>(this.db, sql`
      SELECT r.id,
             r.status,
             r.customer_email,
             r.order_id,
             o.remote_order_id,
             s.domain AS site_domain,
             r.reason_excerpt,
             r.reason_len,
             r.within_warranty,
             r.created_at
      FROM (
        SELECT id,
               status::text AS status,
               customer_email,
               order_id,
               site_id,
               left(reason, ${REASON_EXCERPT_LEN}::int) AS reason_excerpt,
               length(reason)::int AS reason_len,
               within_warranty,
               created_at
        FROM replacement_requests
        -- id tiebreak: aynı ms'deki iki talep poll'lar arasında YER DEĞİŞTİRMESİN
        -- (sıra kararsızsa veri değişmeden ETag değişir, 304 kazanımı kaybolur).
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      ) r
      LEFT JOIN orders o ON o.id = r.order_id
      LEFT JOIN sites s ON s.id = r.site_id
      ORDER BY r.created_at DESC, r.id DESC;
    `);

    return rows.map((r) => {
      const excerpt = r.reason_excerpt ?? '';
      return {
        id: r.id,
        status: r.status,
        customerEmail: r.customer_email,
        orderId: r.order_id,
        remoteOrderId: r.remote_order_id ?? null,
        siteDomain: r.site_domain ?? null,
        reasonExcerpt: Number(r.reason_len ?? 0) > REASON_EXCERPT_LEN ? `${excerpt}…` : excerpt,
        withinWarranty: r.within_warranty === true,
        createdAt: toIso(r.created_at),
      };
    });
  }

  /** En yeni N bildirim (çan dropdown'ı). notifications_created_idx'ten karşılanır. */
  private async liveNotifications(limit: number): Promise<LiveNotificationRow[]> {
    const rows = await rawRows<{
      id: string;
      type: string;
      severity: string;
      title: string;
      message: string;
      created_at: Date | string;
      read_at: Date | string | null;
    }>(this.db, sql`
      SELECT id, type, severity, title, message, created_at, read_at
      FROM notifications
      -- id tiebreak → sıra kararlı (ETag flap etmez, bkz. liveOrders).
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit};
    `);

    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      severity: r.severity,
      title: r.title,
      message: r.message,
      createdAt: toIso(r.created_at),
      readAt: r.read_at ? toIso(r.read_at) : null,
    }));
  }

  /** Okunmamış bildirim sayısı (çan rozeti). notifications_unread_idx (partial) kapsar. */
  private async unreadNotificationCount(): Promise<number> {
    const rows = await rawRows<{ c: number }>(this.db, sql`
      SELECT count(*)::int AS c FROM notifications WHERE read_at IS NULL;
    `);
    return Number(rows[0]?.c ?? 0);
  }

  /**
   * Üst şerit sayaçları TEK sorguda (skalar alt-sorgular). Ayrı ayrı 4 gidiş-dönüş yerine
   * tek round-trip → 15 sn'lik poll'da ağ/bağlantı maliyeti düşer.
   * pendingLines: eşlemesi OLAN bekleyen satır · unmappedLines: eşlemesi OLMAYAN (product_id NULL).
   * İkisinde de iptal (canceled=true) satırlar HARİÇ — onlar asla teslim edilmez (§2).
   * unmappedOrders: EN AZ BİR eşlemesiz aktif satırı olan SİPARİŞ (bkz. UNMAPPED_ORDERS_COUNT) —
   * unmappedLines'ın sipariş bazında tekilleştirilmiş hâli; ikisi de AYNI satır kümesini okur,
   * dolayısıyla "kaç satır / kaç sipariş" cevapları birbiriyle her zaman tutarlıdır.
   *
   * PERF NOTU: üç satır-tabanlı sayaç da `order_lines_pending_fifo_idx` KISMİ index'inin
   * YÜKLEMİYLE (WHERE status IN ('pending','partial') AND canceled = false) örtüşür ve tek
   * gidiş-dönüşte skalar alt-sorgu olarak toplanır (ek round-trip YOK). Örtüşme kısmi yüklemde
   * tamdır; index'in kolon listesi (product_id, priority DESC, created_at) sayımın
   * gerektirdiğinden geniştir — kazanç "yalnız iş bekleyen alt küme taranır"dan gelir.
   * (Yorum eskiden DÜŞÜRÜLMÜŞ `order_lines_pending_product_idx` adına dayanıyordu —
   * migration 0042; ön eki/kısmi koşulu aynı olduğu için plan kaybı yok.)
   * unmappedOrders tekilleştirme için heap'ten order_id okur; bu yine de eski
   * `orders.status='unmapped'` sayımından ucuzdur. Migration bu partide kapsam DIŞI.
   */
  private async liveCounters(): Promise<
    Omit<LiveStats, 'lowStockProducts' | 'unmappedCatalogProducts'>
  > {
    const rows = await rawRows<{
      open_support: number;
      held_orders: number;
      pending_lines: number;
      unmapped_lines: number;
      unmapped_orders: number;
    }>(this.db, sql`
      SELECT
        (SELECT count(*)::int FROM replacement_requests
          WHERE status IN ('open', 'info_requested')) AS open_support,
        (SELECT count(*)::int FROM orders
          WHERE held_for_review = true) AS held_orders,
        (SELECT count(*)::int FROM order_lines
          WHERE product_id IS NOT NULL
            AND status IN ('pending', 'partial')
            AND canceled = false) AS pending_lines,
        (SELECT count(*)::int FROM order_lines
          WHERE product_id IS NULL
            AND status IN ('pending', 'partial')
            AND canceled = false) AS unmapped_lines,
        ${UNMAPPED_ORDERS_COUNT} AS unmapped_orders;
    `);
    const r = rows[0];
    return {
      openSupport: Number(r?.open_support ?? 0),
      heldOrders: Number(r?.held_orders ?? 0),
      pendingLines: Number(r?.pending_lines ?? 0),
      unmappedLines: Number(r?.unmapped_lines ?? 0),
      unmappedOrders: Number(r?.unmapped_orders ?? 0),
    };
  }
}
