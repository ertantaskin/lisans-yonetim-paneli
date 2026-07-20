import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * Parti satırı (GET /v1/admin/batches yanıtı).
 * supplierName + product (sku/name) API tarafında JOIN ile getirilir;
 * unsoldCount/soldCount RAW SQL license_items batch_id sayımıdır.
 * NOT: Alan adları W2 API kontratıyla hizalanmalı (orkestratöre not düşüldü).
 */
export interface BatchRow {
  id: string;
  label: string;
  supplierId: string | null;
  supplierName: string | null;
  productId: string;
  productSku: string;
  productName: string;
  /** 'active' | 'recalled' | 'voided' */
  status: string;
  qtyReceived: number;
  /** Satılmamış (license_items status='available') adet — recall'da void edilir. */
  unsoldCount: number;
  /** Satılmış/atanmış adet — recall'da değişim gerektirir (uyarı). */
  soldCount: number;
  receivedAt: string;
  notes: string | null;
  createdAt: string;
}

/** Tüm partileri getirir (receivedAt DESC). */
export async function getBatches(): Promise<BatchRow[]> {
  const data = await apiGet<{ items: BatchRow[] }>('/v1/admin/batches');
  return data.items;
}
