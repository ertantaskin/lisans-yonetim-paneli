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
  },
};
