import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * İnceleme kuyruğu satırı (GET /v1/admin/review yanıtı, §8 held_for_review).
 * Dinamik satış kotası eşiğini aşan siparişler reddedilmez, manuel onay için
 * tutulur (held). remoteOrderId / siteDomain API tarafında JOIN ile getirilir.
 */
export interface ReviewRow {
  id: string;
  remoteOrderId: string;
  customerEmail: string;
  status: string;
  heldAt: string | null;
  heldReason: string | null;
  createdAt: string;
  siteId: string;
  siteDomain: string | null;
  lineCount: number;
}

/**
 * İnceleme bekleyen (held) siparişleri getirir. API bare dizi VEYA `{ items }`
 * sarmalı döndürebilir; her iki biçim de güvenle normalize edilir.
 */
export async function getReviewQueue(): Promise<ReviewRow[]> {
  const data = await apiGet<ReviewRow[] | { items: ReviewRow[] }>('/v1/admin/review');
  return Array.isArray(data) ? data : (data?.items ?? []);
}
