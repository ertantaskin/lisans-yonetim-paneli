import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * Değişim/destek talebi satırı (GET /v1/admin/replacements yanıtı).
 * remoteOrderId API tarafında orders JOIN ile getirilir.
 */
export interface ReplacementRow {
  id: string;
  siteId: string;
  orderId: string;
  remoteOrderId: string;
  lineId: string | null;
  assignmentId: string | null;
  customerEmail: string;
  reason: string;
  status: string;
  withinWarranty: boolean;
  resolutionNote: string | null;
  createdAt: string;
}

/** Değişim taleplerini getirir. status verilirse sunucu filtreler; yoksa hepsi (createdAt DESC). */
export async function getReplacements(status?: string): Promise<ReplacementRow[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const data = await apiGet<{ items: ReplacementRow[] }>(`/v1/admin/replacements${qs}`);
  return data.items;
}
