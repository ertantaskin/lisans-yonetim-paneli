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

/**
 * GET /v1/admin/purchase-orders — tedarikçi + ürün JOIN'li emirler.
 *
 * ZARF ({items, truncated}): uç bir dönem SINIRSIZ dizi döndürüyordu. `purchase_orders`
 * artık HER stok girişinde bir satır kazanıyor (otomatik teslim-alma emri), yani liste
 * zamanla tüm tabloyu çekip her açılışta tam sıralama yapardı. Okuma SAVUNMACI: eski API
 * (düz dizi) dağıtım sapmasında hâlâ çalışır — admin ve api ayrı imajlardır.
 */
export async function getPurchaseOrders(): Promise<{
  items: PurchaseOrderRow[];
  truncated: boolean;
}> {
  const res = await apiGet<{ items: PurchaseOrderRow[]; truncated: boolean } | PurchaseOrderRow[]>(
    '/v1/admin/purchase-orders',
  );
  return Array.isArray(res)
    ? { items: res, truncated: false }
    : { items: res?.items ?? [], truncated: res?.truncated === true };
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
