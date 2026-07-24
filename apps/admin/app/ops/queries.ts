import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * Dead-letter satırı (GET /v1/admin/ops/dead-letter yanıtı). Başarısız geri-kanal
 * webhook (outbox) + başarısız/bounce mail (email). Sır/payload İÇERMEZ.
 */
export interface DeadLetterRow {
  kind: 'outbox' | 'email';
  id: string;
  label: string;
  status: string;
  error: string | null;
  attempts: number | null;
  orderId: string | null;
  toEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Başarısız outbox + mail kayıtlarını getirir (updatedAt DESC, API limit 100). */
export async function getDeadLetter(): Promise<DeadLetterRow[]> {
  const data = await apiGet<DeadLetterRow[] | { items: DeadLetterRow[] }>('/v1/admin/ops/dead-letter');
  return Array.isArray(data) ? data : (data?.items ?? []);
}
