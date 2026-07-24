import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * Güvenlik olayı satırı (GET /v1/admin/security-events yanıtı, DESC).
 * security_events tablosu: velocity/quota_exceeded/anomaly/blocklist tipleri.
 */
export interface SecurityEventRow {
  id: string;
  type: string;
  severity: string;
  siteId: string | null;
  subject: string | null;
  detail: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Güvenlik olaylarını getirir. type verilirse sunucu filtreler; yoksa hepsi (createdAt DESC).
 * API yanıtı {items:[]} veya doğrudan dizi olabilir → ikisini de normalize eder.
 */
export async function getSecurityEvents(type?: string): Promise<SecurityEventRow[]> {
  const qs = type ? `?type=${encodeURIComponent(type)}` : '';
  const data = await apiGet<{ items: SecurityEventRow[] } | SecurityEventRow[]>(
    `/v1/admin/security-events${qs}`,
  );
  return Array.isArray(data) ? data : (data?.items ?? []);
}
