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
  /** Sipariş verdiği site alan adları (site süzgeci uygulandıysa tek eleman). */
  sites: string[];
  firstOrderAt: string | null;
  lastOrderAt: string | null;
}

/** Site süzgeci için hafif site seçeneği. */
export interface SiteOption {
  id: string;
  domain: string;
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
  /**
   * Sipariş geçmişi. `siteDomain` liste ekranındaki "Siteler" kolonunun detaydaki karşılığıdır —
   * aynı müşteri iki mağazadan alışveriş yaptıysa satırlar ancak böyle ayırt edilir.
   * Eski API sürümünde alan gelmeyebilir (ayrı imajlar) → savunmacı okunur, ekran '—' basar.
   */
  orders: Array<{
    id: string;
    remoteOrderId: string;
    status: string;
    createdAt: string;
    siteDomain?: string | null;
  }>;
  /** Değişim talepleri — `orderId` varsa satır siparişe tıklanabilir olur. */
  replacements: Array<{
    id: string;
    status: string;
    reason: string;
    createdAt: string;
    orderId?: string | null;
    remoteOrderId?: string | null;
    siteDomain?: string | null;
  }>;
}

/**
 * Müşteri listesi. `siteId` verilirse SADECE o sitenin müşterileri + o siteye kapsanmış
 * sayılar döner (site → müşteri hiyerarşisi). Sıralama/filtre istemcide DataTable'da.
 */
export async function getCustomers(opts?: {
  search?: string;
  siteId?: string;
}): Promise<{ items: CustomerRow[]; truncated: boolean }> {
  const params = new URLSearchParams();
  if (opts?.search) params.set('search', opts.search);
  if (opts?.siteId) params.set('siteId', opts.siteId);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const data = await apiGet<CustomerRow[] | { items: CustomerRow[]; truncated?: boolean }>(
    `/v1/admin/customers${qs}`,
  );
  // `truncated`: sunucu üst sınıra dayandı → EKRANDA SÖYLENİR. Arama/sıralama istemcide
  // yapıldığı için sessiz kırpma "o müşteri yok" demeye götürürdü (yaşanmış sınıf).
  if (Array.isArray(data)) return { items: data, truncated: false };
  return { items: data?.items ?? [], truncated: data?.truncated === true };
}

/** Site süzgeci için site listesi (id + domain). Dizi veya {items} şekline dayanıklı. */
export async function getSitesForFilter(): Promise<SiteOption[]> {
  const data = await apiGet<unknown>('/v1/admin/sites');
  const arr = (Array.isArray(data) ? data : ((data as { items?: unknown })?.items ?? [])) as Array<{
    id: string;
    domain: string;
  }>;
  return arr.map((s) => ({ id: s.id, domain: s.domain }));
}

/** Tek müşteri 360 görünümü (stats + sipariş + değişim + etiket/not). */
export async function getCustomer(email: string): Promise<CustomerDetail> {
  return apiGet<CustomerDetail>(`/v1/admin/customers/${encodeURIComponent(email)}`);
}
