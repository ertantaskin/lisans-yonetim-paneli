import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * Bildirim satırı (GET /v1/admin/notifications yanıtı — notifications tablosu).
 * severity: 'info' | 'warning' | 'critical'. meta örn {productId, sku, available, threshold}.
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
}

/**
 * Son bildirimleri getirir (createdAt DESC). API yanıtı dizi veya {items} olabilir —
 * her iki biçimi de normalize eder.
 */
export async function getNotifications(limit = 50): Promise<NotificationRow[]> {
  const data = await apiGet<NotificationRow[] | { items: NotificationRow[] }>(
    `/v1/admin/notifications?limit=${limit}`,
  );
  return Array.isArray(data) ? data : data.items;
}
