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

/** `/customers` giriş ekranı: mağaza kartı satırı. */
export interface CustomerSiteSummary {
  siteId: string;
  domain: string;
  type: string;
  customerCount: number;
  orderCount: number;
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
 * API tarafındaki SABİT üst sınır (`customers.service` → `CUSTOMER_LIST_LIMIT = 2000`).
 * Ekrandaki kırpma uyarısı bu sabitten türetilir — sayıyı metne gömmek iki yerin sessizce
 * ayrışmasına yol açar (aynı desen: SUPPORT_FETCH_LIMIT / SECURITY_FETCH_LIMIT).
 */
export const CUSTOMERS_FETCH_LIMIT = 2000;

/**
 * UUID kalıbı — `?site=` adres çubuğundan gelir ve doğrudan API'ye iletiliyordu; geçersiz
 * bir değer (elle düzenlenmiş/bayat link) API'de 500 üretip TÜM ekranı hata kartına
 * düşürüyordu. Kalıba uymayan değer artık süzgeç olarak UYGULANMAZ.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?site=` gerçekten bir site kimliği mi? (Sayfa, mod seçiminde de bunu kullanır.) */
export const isValidSiteId = (id: string | undefined | null): id is string =>
  typeof id === 'string' && UUID_RE.test(id);

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
  // Savunma derinliği: sayfa zaten doğruluyor, burada da geçersiz kimlik hiç gönderilmez.
  if (isValidSiteId(opts?.siteId)) params.set('siteId', opts.siteId);
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

/**
 * Mağaza başına müşteri özeti — `/customers` giriş ekranı (site → müşteri hiyerarşisi).
 * Eski API sürümünde uç olmayabilir (api/admin dağıtım sapması) → çağıran tarafta
 * try/catch ile boş listeye düşer, ekran arama kutusuyla çalışmaya devam eder.
 */
export async function getCustomerSiteSummary(): Promise<CustomerSiteSummary[]> {
  const data = await apiGet<CustomerSiteSummary[] | { items?: CustomerSiteSummary[] }>(
    '/v1/admin/customers/site-summary',
  );
  return Array.isArray(data) ? data : (data?.items ?? []);
}

/** Tek müşteri 360 görünümü (stats + sipariş + değişim + etiket/not). */
export async function getCustomer(email: string): Promise<CustomerDetail> {
  return apiGet<CustomerDetail>(`/v1/admin/customers/${encodeURIComponent(email)}`);
}
