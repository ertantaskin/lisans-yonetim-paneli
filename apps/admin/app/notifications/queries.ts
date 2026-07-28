import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * Bildirim satırı (GET /v1/admin/notifications yanıtı — notifications tablosu).
 * severity: 'info' | 'warning' | 'critical'. meta örn {productId, sku, available, threshold}.
 * `readAt` null = OKUNMAMIŞ (üst bardaki çan rozeti bu alandan sayılır).
 */
export interface NotificationRow {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  meta: Record<string, unknown> | null;
  sentTelegram: boolean;
  createdAt: string;
  /** Okundu zamanı (ISO) — null ise okunmamış. */
  readAt: string | null;
}

/**
 * Ham API satırı. Alanlar opsiyoneldir: api ve admin AYRI imajlar olarak dağıtılır (deploy
 * sapması) → `readAt` döndürmeyen ESKİ bir API'ye karşı ekran çökmez, alan null'a düşer
 * (o durumda her satır "okunmamış" görünür; yanlış BİLGİ değil, yalnız eksik özellik).
 */
type RawNotificationRow = Partial<Omit<NotificationRow, 'id'>> & { id: string };

/**
 * Ekranda gösterilen bildirim sayısı. API üst sınırı 200'dür; burada 100 seçildi — liste
 * istemci tarafında süzülüp sıralandığı için tarayıcıya taşınan veri sınırlı tutulur.
 */
export const NOTIFICATIONS_LIMIT = 100;

export interface NotificationsData {
  rows: NotificationRow[];
  /** Üst sınıra dayanıldı → daha eski bildirimler bu listede YOK (sessiz kırpma olmasın). */
  truncated: boolean;
}

function normalize(r: RawNotificationRow): NotificationRow {
  return {
    id: r.id,
    type: r.type ?? '',
    severity: r.severity ?? 'info',
    title: r.title ?? '',
    message: r.message ?? '',
    meta: r.meta ?? null,
    sentTelegram: r.sentTelegram === true,
    createdAt: r.createdAt ?? new Date(0).toISOString(),
    readAt: r.readAt ?? null,
  };
}

/**
 * Son bildirimleri getirir (createdAt DESC). API yanıtı dizi veya {items} olabilir —
 * her iki biçimi de normalize eder.
 */
export async function getNotifications(limit = NOTIFICATIONS_LIMIT): Promise<NotificationsData> {
  const data = await apiGet<RawNotificationRow[] | { items: RawNotificationRow[] }>(
    `/v1/admin/notifications?limit=${limit}`,
  );
  const raw = Array.isArray(data) ? data : (data?.items ?? []);
  const rows = raw.filter((r) => r && typeof r.id === 'string').map(normalize);
  return { rows, truncated: rows.length >= limit };
}
