import 'server-only';
import { randomUUID } from 'node:crypto';

/**
 * Sunucu-taraflı API istemcisi. ADMIN_TOKEN yalnız Next sunucusunda kalır,
 * tarayıcıya ASLA gönderilmez. Tüm admin çağrıları buradan geçer.
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

function headers(withBody: boolean, actor?: string): Record<string, string> {
  const h: Record<string, string> = { 'x-admin-token': ADMIN_TOKEN };
  if (withBody) h['content-type'] = 'application/json';
  // Trace-Id uçtan uca (§16): her Next sunucu→API çağrısına yeni bir trace-id
  // üret. API genReqId bunu req.id yapar ve yanıtta x-trace-id olarak echo eder,
  // böylece admin kaynaklı istekler loglarda uçtan uca izlenebilir.
  h['x-trace-id'] = randomUUID();
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

/**
 * Non-2xx yanıttan tipli `ApiError` üretir: HTTP status KORUNUR (detay sayfalarındaki
 * `status === 404 → notFound()` dalları çalışır) ve kullanıcı-dostu mesaj API'nin JSON hata
 * gövdesinin `message` alanından alınır — HAM gövde (Nest hata JSON'u) mesaja GÖMÜLMEZ
 * (iç detay/sır kullanıcıya sızmaz). `message` yoksa generic `METHOD path → status` kalır.
 */
async function toApiError(method: string, path: string, res: Response): Promise<ApiError> {
  let message = `${method} ${path} → ${res.status}`;
  try {
    const data = (await res.json()) as { message?: unknown };
    const m = data?.message;
    if (typeof m === 'string' && m.trim()) {
      message = m;
    } else if (Array.isArray(m)) {
      const joined = m.filter((x): x is string => typeof x === 'string').join('; ');
      if (joined) message = joined;
    }
  } catch {
    /* gövde JSON değil → generic mesaj kalır */
  }
  return new ApiError(res.status, message);
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: headers(false),
    cache: 'no-store',
  });
  if (!res.ok) throw await toApiError('GET', path, res);
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body?: unknown, actor?: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: headers(body !== undefined, actor),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) throw await toApiError('POST', path, res);
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
  if (!res.ok) throw await toApiError(method, path, res);
  return res.json() as Promise<T>;
}

/**
 * Sunucu-taraflı HAM API çağrısı — `Response`'u OLDUĞU GİBİ döndürür (status + gövde
 * dokunulmaz). apiGet/apiPost non-2xx'te THROW eder; oysa bazı proxy'ler API yanıtını
 * verbatim geçirmeli (ör. AI uçlarında 503/400/`ok:false`-in-200 anlamlıdır) VEYA graceful
 * düşmeli. Bu yardımcı token + trace-id (§16) (+ opsiyonel actor) başlıklarını MERKEZÎ üretir
 * — böylece inline fetch kopyalayan route'lar artık x-trace-id DÜŞÜRMEZ; çağıran kendi
 * status/gövde mantığını korur. ADMIN_TOKEN yalnız sunucuda kalır.
 */
export async function apiRaw(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts?: { body?: unknown; actor?: string },
): Promise<Response> {
  const withBody = opts?.body !== undefined;
  return fetch(`${API_URL}${path}`, {
    method,
    headers: headers(withBody, opts?.actor),
    body: withBody ? JSON.stringify(opts!.body) : undefined,
    cache: 'no-store',
  });
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
  /** Değişim soyağacı (§3 "eski anahtarlar"): eski key MASKELİ (son-4), yeni atama id'si. */
  history: Array<{
    id: string;
    assignmentId: string;
    reason: string;
    actor: string;
    createdAt: string;
    oldMasked: string;
  }>;
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
