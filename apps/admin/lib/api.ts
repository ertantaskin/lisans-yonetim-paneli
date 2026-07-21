import 'server-only';

/**
 * Sunucu-taraflı API istemcisi. ADMIN_TOKEN yalnız Next sunucusunda kalır,
 * tarayıcıya ASLA gönderilmez. Tüm admin çağrıları buradan geçer.
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

function headers(withBody: boolean, actor?: string): Record<string, string> {
  const h: Record<string, string> = { 'x-admin-token': ADMIN_TOKEN };
  if (withBody) h['content-type'] = 'application/json';
  // Eylemi yapan admin (audit attribution, §8). getActor() ile session'dan gelir;
  // ADMIN_TOKEN ile aynı güven düzeyi (token'sız istemci API'ye erişemez).
  if (actor) h['x-admin-actor'] = actor;
  return h;
}

/**
 * HTTP durum kodunu taşıyan tipli API hatası. Detay sayfaları `status === 404`
 * dalında `notFound()` çağırıp global not-found.tsx'i render eder; diğer durumlar
 * mevcut inline hata kartına düşer. `Error`'dan türer → mevcut `e instanceof Error`
 * yakalayıcıları ve `.message` erişimi aynen çalışır (geriye dönük uyumlu).
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: headers(false),
    cache: 'no-store',
  });
  if (!res.ok) throw new ApiError(res.status, `GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body?: unknown, actor?: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: headers(body !== undefined, actor),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${path} → ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function apiSend<T>(
  method: 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  actor?: string,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: headers(body !== undefined, actor),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Paylaşılan tipler (API yanıtları) ───────────────────────────────────────
export interface OrderRow {
  id: string;
  remoteOrderId: string;
  customerEmail: string;
  status: string;
  createdAt: string;
}

export interface PayloadFieldDef {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
}

export interface ProductRow {
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
  availableStock: number;
  // Düzenleme formunun ön-dolumu için (API list() tam product satırı döndürür).
  // stockless checkbox'ı ön-dolmazsa düzenlemede sessizce false'a çekiliyordu.
  stockless: boolean;
  releaseAt: string | null;
  warrantyDays: number | null;
  lowStockThreshold: number | null;
  keyFormat: string | null;
}

export interface SiteRow {
  id: string;
  domain: string;
  type: string;
  status: string;
  senderEmail: string | null;
  /** Geri kanal webhook hedefi (§2) — null = webhook devre dışı. */
  webhookUrl: string | null;
}

export interface OrderDetail {
  order: OrderRow & { siteId: string };
  lines: Array<{
    id: string;
    remoteLineId: string;
    qty: number;
    fulfilledQty: number;
    status: string;
    productId: string | null;
  }>;
  assignments: Array<{
    id: string;
    lineId: string;
    status: string;
    units: number;
    kind: string;
    maskedPayload: string;
    /** account ürünlerde alan-alan maskeli görünüm; diğer tiplerde null. */
    maskedFields: Array<{ key: string; label: string; value: string; secret: boolean }> | null;
    validUntil: string | null;
    /** multi (MAK) kapasite görünürlüğü. */
    maxUses: number;
    useCount: number;
  }>;
  events: Array<{ id: string; type: string; message: string | null; createdAt: string }>;
  emails: Array<{ id: string; toEmail: string; subject: string; status: string }>;
}

/** POST /v1/admin/assignments/:id/reveal yanıtı (loglu). */
export interface RevealResult {
  payload: string;
  fields: Array<{ key: string; label: string; value: string; secret: boolean }> | null;
}

// ── Admin kullanıcıları (çoklu admin, §8) ────────────────────────────────────
export interface AdminUser {
  id: string;
  email: string;
  username: string | null;
  name: string;
  role: string;
  disabled: boolean;
  tokenVersion: number;
  lastLoginAt: string | null;
  createdAt: string;
}

/** Kimlik + parola doğrular (API admin_users). Başarısızsa null (401), diğer hatalarda throw. */
export async function adminLogin(identifier: string, password: string): Promise<AdminUser | null> {
  const res = await fetch(`${API_URL}/v1/admin/auth/login`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ identifier, password }),
    cache: 'no-store',
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`login → ${res.status}`);
  const data = (await res.json()) as { user: AdminUser };
  return data.user;
}
