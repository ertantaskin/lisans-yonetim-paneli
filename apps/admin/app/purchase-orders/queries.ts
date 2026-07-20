import 'server-only';
import { apiGet, type ProductRow } from '@/lib/api';

/**
 * Satın alma emri (§12) — liste satırı, tedarikçi adı + ürün sku/adı JOIN'li.
 * qtyReceived teslim alındıkça artar; status draft→ordered→partial→received.
 */
export interface PurchaseOrderRow {
  id: string;
  supplierId: string;
  supplierName: string;
  productId: string;
  productSku: string;
  productName: string;
  status: string;
  qtyOrdered: number;
  qtyReceived: number;
  unitCostCents: number | null;
  currency: string;
  eta: string | null;
  orderedAt: string | null;
  receivedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Seçim kutuları için sadeleştirilmiş tedarikçi (aktif olanlar). */
export interface SupplierOption {
  id: string;
  name: string;
  active: boolean;
}

/** GET /v1/admin/purchase-orders — tedarikçi + ürün JOIN'li tüm emirler. */
export async function getPurchaseOrders(): Promise<PurchaseOrderRow[]> {
  return apiGet<PurchaseOrderRow[]>('/v1/admin/purchase-orders');
}

/** GET /v1/admin/purchase-orders/:id — tek emir (JOIN'li). */
export async function getPurchaseOrder(id: string): Promise<PurchaseOrderRow> {
  return apiGet<PurchaseOrderRow>(`/v1/admin/purchase-orders/${id}`);
}

/** Oluşturma formu için tedarikçi + ürün listeleri (paralel çekilir). */
export async function getPurchaseOrderFormData(): Promise<{
  suppliers: SupplierOption[];
  products: ProductRow[];
}> {
  const [suppliers, products] = await Promise.all([
    apiGet<SupplierOption[]>('/v1/admin/suppliers'),
    apiGet<ProductRow[]>('/v1/admin/products'),
  ]);
  return { suppliers, products };
}
