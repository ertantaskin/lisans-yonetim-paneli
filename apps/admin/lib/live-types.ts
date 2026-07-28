/**
 * Canlı akış (iş istasyonu) kontratı — `GET /v1/admin/live` yanıtı (§17).
 *
 * TEK uç, TEK poll: üst bardaki bildirim çanı ve genel bakış ekranındaki canlı listeler
 * aynı yanıtı paylaşır. Ekran başına ayrı poller AÇILMAZ (tarayıcı gün boyu açık kalacak —
 * gereksiz istek = gereksiz DB yükü).
 *
 * 'server-only' DEĞİL: bu dosya yalnız tip içerir ve istemci bileşenlerinden de import edilir.
 */

export interface LiveOrder {
  id: string;
  remoteOrderId: string;
  siteId: string;
  siteDomain: string;
  customerEmail: string;
  status: string;
  held: boolean;
  lineCount: number;
  fulfilledLines: number;
  createdAt: string;
  /**
   * Bu siparişte panel ürününe BAĞLANMAMIŞ en az bir aktif satır var mı
   * (`product_id IS NULL AND canceled = false`).
   *
   * NEDEN AYRI BİR ALAN: sipariş DURUMU ('unmapped') ancak sipariş BÜTÜNÜYLE eşlemesizse
   * o değeri alır. Çok kalemli siparişte tek kalem eşlemesiz kalırsa durum 'pending'/'partial'
   * olur ve satır listede işaretsiz görünürdü — oysa `stats.unmappedOrders` sayacı SATIR
   * tabanlıdır: sayaç "1" derken listede işaretli satır olmuyordu (sayaç ↔ liste çelişkisi).
   *
   * OPSİYONEL: api/admin dağıtım sapmasında (eski API sürümü) alan hiç gelmeyebilir →
   * okurken `?? false`; o durumda bugünkü davranış (yalnız durum='unmapped') birebir korunur.
   */
  hasUnmappedLine?: boolean;
}

export interface LiveSupport {
  id: string;
  status: string;
  customerEmail: string;
  orderId: string | null;
  remoteOrderId: string | null;
  siteDomain: string | null;
  reasonExcerpt: string;
  withinWarranty: boolean;
  createdAt: string;
}

export interface LiveNotification {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  createdAt: string;
  readAt: string | null;
}

export interface LiveStats {
  openSupport: number;
  heldOrders: number;
  /** Eşli ama henüz teslim edilmemiş satırlar. */
  pendingLines: number;
  /** Mağaza ürünü panelde eşlenmediği için bekleyen satırlar (operatör aksiyonu gerekir). */
  unmappedLines: number;
  lowStockProducts: number;
  /**
   * GERÇEK TALEP sayacı: en az bir eşlemesiz AKTİF satırı olan sipariş sayısı
   * (`product_id IS NULL AND canceled = false AND status IN ('pending','partial')`
   * satırı bulunan DISTINCT sipariş).
   *
   * DİKKAT — anlam değişti: eskiden `orders.status = 'unmapped'` idi, yani siparişin
   * BÜTÜNÜYLE eşlemesiz olması gerekiyordu. Çok kalemli siparişte durum 'pending'
   * olup yalnız bir kalem eşlemesiz olabilir; o sipariş de artık bu sayaca girer.
   * Metinler buna göre kurulmalı ("siparişte ... bağlı değil", "sipariş eşlenmemiş" DEĞİL).
   *
   * Panelde teslimatı fiilen durduran TEK arıza budur → kırmızı (destructive) alarm
   * YALNIZ bu sayaçtan türetilir. OPSİYONEL: api/admin dağıtım sapmasında (eski API
   * sürümü) alan hiç gelmeyebilir — okurken `?? 0`, 0/undefined ise alarm HİÇ çizilmez.
   */
  unmappedOrders?: number;
  /**
   * BİLGİ sayacı (alarm DEĞİL): mağaza kataloğunda aktif panel eşlemesi olmayan ürün sayısı.
   *
   * Katalog mağazanın TÜM ürünlerini taşır — lisans taşımayanlar (kargo, hizmet, fiziksel
   * ürün…) dahil. Bu yüzden "eşlenmemiş" ≠ "eşlenmesi gereken": sayaç doğru çalışan bir
   * mağazada da kalıcı olarak > 0 kalabilir. Kırmızı bant/alarm ASLA buradan türetilmez
   * (sönmeyen alarm = alarm körlüğü + operatörü tehlikeli "her şeyi eşle" davranışına iter).
   * OPSİYONEL (yukarıdaki gerekçe).
   */
  unmappedCatalogProducts?: number;
}

export interface LivePayload {
  ts: string;
  orders: LiveOrder[];
  supports: LiveSupport[];
  notifications: { unread: number; recent: LiveNotification[] };
  stats: LiveStats;
}

/** Veri gelmeden önceki güvenli boş durum (UI hiçbir zaman undefined görmez). */
export const EMPTY_LIVE: LivePayload = {
  ts: '',
  orders: [],
  supports: [],
  notifications: { unread: 0, recent: [] },
  stats: {
    openSupport: 0,
    heldOrders: 0,
    pendingLines: 0,
    unmappedLines: 0,
    lowStockProducts: 0,
    // Boş durumda 0 → eşleme alarmı HİÇ çizilmez (veri gelmeden alarm verilmez).
    unmappedOrders: 0,
    unmappedCatalogProducts: 0,
  },
};
