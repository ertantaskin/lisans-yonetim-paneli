import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';

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
   * Düşük stok ürünü sayısı (summary().lowStockCount ile AYNI tanım — aynı önbelleği
   * paylaşırlar). ≤60 sn bayat olabilir (bkz. LOW_STOCK_CACHE_TTL_MS); uyarı sayacı
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
 * Düşük-stok sayacının SÜREÇ-İÇİ önbellek ömrü (ms).
 *
 * NEDEN önbellek: bu sayaç canlı anlık görüntünün EN pahalı parçasıdır (products ×
 * license_items agregasyonu — diğer 5 sorgu nokta-index'lidir). Panel mesai boyunca AÇIK
 * kalan bir iş istasyonudur ve her sekme 15 sn'de bir poll eder → 3 sekme = dakikada 12
 * agregasyon. Düşük stok DAKİKALAR ölçeğinde anlamlı bir operatör uyarısıdır (saniyeler
 * değil), dolayısıyla ≤60 sn bayatlık kabul edilebilir ve yük "sekme sayısı × 4/dk"
 * yerine "dakikada EN FAZLA 1"e iner.
 *
 * NEDEN 60 sn: poll periyodunun (15 sn) tam katı → her 4 poll'da bir tazelenir; ETag de
 * bu yüzden gereksiz yere flap etmez (aradaki 3 poll'da sayaç sabit → 304 korunur).
 *
 * BİLİNÇLİ TAKAS: önbellek süreç-içidir; çok-örnekli dağıtımda örnekler arası kısa süreli
 * sapma görülebilir. Kabul edilebilir çünkü bu YALNIZ bir uyarı sayacıdır — teslimat/atama
 * kararları buna dayanmaz, gerçek düşük-stok alarmı ayrı cron'dan (low-stock.service) üretilir.
 */
const LOW_STOCK_CACHE_TTL_MS = 60_000;

/** pg timestamptz (Date | string) → ISO. postgres.js Date döndürür; string de tolere edilir. */
function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

/**
 * Panel genel-bakış özeti (§13). Tümü mevcut tablolardan salt-okunur agregasyon;
 * yeni tablo/migration yok. KPI'lar tek doğruluk kaynağından (panel) türetilir.
 */
export interface DashboardSummary {
  /** Teslim bekleyen sipariş satırı (order_lines.status IN pending|partial). */
  pendingLines: number;
  /** Bugün (yerel gün başı, sunucu TZ) oluşturulan sipariş sayısı. */
  todayOrders: number;
  /**
   * Düşük stok ürünü sayısı (low_stock_threshold IS NOT NULL AND available<=eşik).
   * ≤60 sn önbellekli (LOW_STOCK_CACHE_TTL_MS) — canlı uçla aynı değer.
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
   * Düşük-stok sayacı önbelleği (bkz. LOW_STOCK_CACHE_TTL_MS). Servis singleton olduğu
   * için alan süreç ömrü boyunca yaşar; kalıcılık/invalidasyon YOKTUR (TTL yeter).
   */
  private lowStockCache: { value: number; at: number } | null = null;
  /**
   * Süren hesap. NEDEN: önbellek boşken aynı anda gelen N poll (çok sekme) aksi halde N
   * ayrı agregasyon başlatırdı — "sürü etkisi" tam da kaçındığımız yükü geri getirirdi.
   * Bekleyenler tek sorgunun sonucunu paylaşır.
   */
  private lowStockInflight: Promise<number> | null = null;

  /**
   * Düşük-stok sayacını önbellekten servis eder; TTL dolduysa TEK sorgu koşup tazeler.
   * Hata durumunda bayat değere DÜŞÜLMEZ — hata çağırana yansır (önceki davranış korunur).
   */
  private async lowStockCountCached(): Promise<number> {
    const hit = this.lowStockCache;
    if (hit && Date.now() - hit.at < LOW_STOCK_CACHE_TTL_MS) return hit.value;
    if (this.lowStockInflight) return this.lowStockInflight;

    const run = this.lowStockCount()
      .then((value) => {
        this.lowStockCache = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        this.lowStockInflight = null;
      });
    this.lowStockInflight = run;
    return run;
  }

  /** Tüm KPI bloklarını paralel toplayıp tek özet nesnesi döndürür. */
  async summary(): Promise<DashboardSummary> {
    const [
      pendingLines,
      todayOrders,
      lowStockCount,
      openReplacements,
      openSecurityEvents,
      totalAvailableStock,
      recentOrders,
    ] = await Promise.all([
      this.pendingLines(),
      this.todayOrders(),
      // Canlı uçla AYNI önbelleği paylaşır → genel-bakış ile canlı şerit aynı sayıyı gösterir
      // (iki ayrı hesap iki farklı değer üretip "sayı zıplıyor" izlenimi vermesin).
      this.lowStockCountCached(),
      this.openReplacements(),
      this.openSecurityEvents(),
      this.totalAvailableStock(),
      this.recentOrders(),
    ]);
    return {
      pendingLines,
      todayOrders,
      lowStockCount,
      openReplacements,
      openSecurityEvents,
      totalAvailableStock,
      recentOrders,
    };
  }

  /** Teslim bekleyen satır sayısı (pending + partial). */
  private async pendingLines(): Promise<number> {
    const rows = await rawRows<{ c: number }>(this.db, sql`
      SELECT count(*)::int AS c
      FROM order_lines
      WHERE status IN ('pending', 'partial');
    `);
    return Number(rows[0]?.c ?? 0);
  }

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
   * Düşük stok ürünü sayısı. available = status='available' license_item'ların
   * (max_uses - use_count) toplamı (products.service.list ile aynı). Yalnız eşiği
   * TANIMLI ürünler (IS NOT NULL) değerlendirilir; available <= eşik olanlar sayılır.
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
    const rows = await rawRows<{ c: number }>(this.db, sql`
      SELECT count(*)::int AS c
      FROM (
        SELECT p.id
        FROM products p
        LEFT JOIN license_items li
          ON li.product_id = p.id
         AND li.status = 'available'
        WHERE p.low_stock_threshold IS NOT NULL
        GROUP BY p.id
        HAVING coalesce(sum(li.max_uses - li.use_count), 0) <= p.low_stock_threshold
      ) t;
    `);
    return Number(rows[0]?.c ?? 0);
  }

  /** Açık değişim/garanti talebi (open + info_requested). RAW SQL (şema import edilmez). */
  private async openReplacements(): Promise<number> {
    const rows = await rawRows<{ c: number }>(this.db, sql`
      SELECT count(*)::int AS c
      FROM replacement_requests
      WHERE status IN ('open', 'info_requested');
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

  /** Toplam anlık atanabilir stok (available kapasite toplamı). */
  private async totalAvailableStock(): Promise<number> {
    const rows = await rawRows<{ total: number }>(this.db, sql`
      SELECT coalesce(sum(max_uses - use_count), 0)::int AS total
      FROM license_items
      WHERE status = 'available';
    `);
    return Number(rows[0]?.total ?? 0);
  }

  /** En yeni 5 sipariş (özet satır — sır/payload dönmez). */
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
      ORDER BY created_at DESC
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
   *  - toplam 6 sorgu (N ayrı poller yerine tek uç),
   *  - hepsi index'li (orders_created_idx / order_lines_order_idx / notifications_created_idx /
   *    notifications_unread_idx / orders_held_idx / order_lines_pending_product_idx /
   *    replacement_requests_created_idx),
   *  - tek AĞIR blok olan düşük-stok agregasyonu 60 sn önbelleklidir (LOW_STOCK_CACHE_TTL_MS)
   *    → poll başına DEĞİL, dakikada en fazla bir kez koşar,
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

    const [orders, supports, recentNotifications, unread, counters, lowStockProducts] =
      await Promise.all([
        this.liveOrders(n),
        this.liveSupports(n),
        this.liveNotifications(n),
        this.unreadNotificationCount(),
        this.liveCounters(),
        // Poll sıcak yolunun tek "ağır" sorgusu → 60 sn önbellekten (bkz. LOW_STOCK_CACHE_TTL_MS).
        this.lowStockCountCached(),
      ]);

    const snapshot: LiveSnapshot = {
      ts: new Date().toISOString(),
      orders,
      supports,
      notifications: { unread, recent: recentNotifications },
      stats: { ...counters, lowStockProducts },
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
               (count(*) FILTER (WHERE ol.status = 'fulfilled'))::int AS fulfilled_lines
        FROM order_lines ol
        WHERE ol.order_id = o.id
      ) l ON true
      ORDER BY o.created_at DESC, o.id DESC;
    `);

    return rows.map((r) => ({
      id: r.id,
      remoteOrderId: r.remote_order_id,
      siteId: r.site_id,
      siteDomain: r.site_domain ?? '',
      customerEmail: r.customer_email,
      status: r.status,
      held: r.held_for_review === true,
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
   */
  private async liveCounters(): Promise<Omit<LiveStats, 'lowStockProducts'>> {
    const rows = await rawRows<{
      open_support: number;
      held_orders: number;
      pending_lines: number;
      unmapped_lines: number;
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
            AND canceled = false) AS unmapped_lines;
    `);
    const r = rows[0];
    return {
      openSupport: Number(r?.open_support ?? 0),
      heldOrders: Number(r?.held_orders ?? 0),
      pendingLines: Number(r?.pending_lines ?? 0),
      unmappedLines: Number(r?.unmapped_lines ?? 0),
    };
  }
}
