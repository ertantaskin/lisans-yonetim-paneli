import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * Müşteriler ekranı için sunucu-taraflı veri erişimi. ADMIN_TOKEN yalnız Next
 * sunucusunda kalır (apiGet üzerinden). Tipler burada tanımlı; tablo/sayfa
 * yalnız `import type` ile alır (type-only import derlemede silinir → 'server-only'
 * runtime import'u istemci paketine sızmaz).
 */

// ── Tipler (API yanıtları) ───────────────────────────────────────────────────
export interface CustomerRow {
  email: string;
  orderCount: number;
  assignmentCount: number;
  replacementCount: number;
  /** replacementCount / max(assignmentCount, 1) — 0..1 arası oran. */
  replacementRate: number;
  tags: string[];
  firstOrderAt: string | null;
  lastOrderAt: string | null;
}

export interface CustomerDetail {
  email: string;
  tags: string[];
  notes: string | null;
  stats: {
    orderCount: number;
    assignmentCount: number;
    replacementCount: number;
    replacementRate: number;
  };
  orders: Array<{ id: string; remoteOrderId: string; status: string; createdAt: string }>;
  replacements: Array<{ id: string; status: string; reason: string; createdAt: string }>;
}

/** Müşteri listesi (opsiyonel e-posta araması). Sıralama/filtre istemcide DataTable'da. */
export async function getCustomers(search?: string): Promise<CustomerRow[]> {
  const qs = search ? `?search=${encodeURIComponent(search)}` : '';
  const data = await apiGet<{ items: CustomerRow[] }>(`/v1/admin/customers${qs}`);
  return data.items;
}

/** Tek müşteri 360 görünümü (stats + sipariş + değişim + etiket/not). */
export async function getCustomer(email: string): Promise<CustomerDetail> {
  return apiGet<CustomerDetail>(`/v1/admin/customers/${encodeURIComponent(email)}`);
}
