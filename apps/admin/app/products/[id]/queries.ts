import 'server-only';
import { apiGet, type PayloadFieldDef } from '../../../lib/api';

/**
 * Ürün detay ekranı için sunucu-taraflı veri erişimi (§13). ADMIN_TOKEN yalnız
 * Next sunucusunda kalır (apiGet üzerinden). Tipler API yanıtıyla birebir;
 * sayfa yalnız `import type` ile alır (type-only import derlemede silinir).
 */

/** Detay uç tam Product satırını döndürür (list uçtaki türetilmiş availableStock yok). */
export interface ProductRecord {
  id: string;
  sku: string;
  name: string;
  kind: string;
  usageMode: string;
  maxUses: number | null;
  validityDays: number | null;
  onExpiry: string;
  payloadSchema: PayloadFieldDef[] | null;
  fulfillmentPolicy: string;
  lowStockThreshold: number | null;
  // Düzenleme sheet'inin ön-dolumu için (detay ucu tam Product satırı döndürür).
  stockless: boolean;
  releaseAt: string | null;
  warrantyDays: number | null;
  keyFormat: string | null;
  createdAt: string;
}

export interface ProductDetail {
  product: ProductRecord;
  stock: {
    available: number;
    assigned: number;
    revoked: number;
    expired: number;
    voided: number;
  };
  batches: Array<{ id: string; label: string; status: string; qtyReceived: number }>;
  purchaseOrders: Array<{
    id: string;
    status: string;
    qtyOrdered: number;
    qtyReceived: number;
    eta: string | null;
  }>;
  velocity: {
    sold7d: number;
    sold30d: number;
    dailyRate: number;
    daysRemaining: number | null;
  };
  adjustments: Array<{
    id: string;
    action: string;
    qty: number;
    reason: string;
    createdAt: string;
  }>;
  /** Bu ürünün site eşlemeleri (MappingRow ile aynı şekil) — ürün-merkezli yönetim. */
  mappings: Array<{
    id: string;
    siteId: string;
    siteDomain: string;
    productId: string;
    productName: string;
    remoteProductId: string;
    remoteVariationId: string | null;
    bundleQty: number;
    active: boolean;
    createdAt: string;
  }>;
}

/** Tek ürün detay panosu (stok kırılımı + parti + PO + satış hızı + düzeltmeler). */
export async function getProductDetail(id: string): Promise<ProductDetail> {
  return apiGet<ProductDetail>(`/v1/admin/products/${encodeURIComponent(id)}/detail`);
}
