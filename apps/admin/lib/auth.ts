/**
 * Admin UI oturum yönetimi — çoklu admin (§8). Kimlik doğrulama API'de (admin_users);
 * burada yalnız imzalı OTURUM cookie'si üretilir/doğrulanır.
 *
 * Oturum token: `<base64url(payload)>.<base64url(HMAC-SHA256)>` — SESSION_SECRET ile imzalı.
 * Edge-uyumlu (crypto.subtle / btoa / atob) → hem middleware (edge) hem route handler (node).
 * `SESSION_SECRET` set DEĞİLSE auth KAPALI (gate devre dışı, lockout riski yok).
 */
export const SESSION_COOKIE = 'admin_session';

/**
 * İmzalı oturum ömrü (saniye). Cookie maxAge ile TEK kaynak — ikisi ayrışırsa
 * cookie token'dan uzun yaşar ve "geçerli görünen ama süresi dolmuş" istek üretir.
 */
export const SESSION_TTL_SEC = 60 * 60 * 12; // 12 saat

export interface SessionPayload {
  sub: string; // admin id
  email: string;
  name: string;
  role: string; // owner | admin
  ver: number; // tokenVersion — iptal kontrolü
  exp: number; // unix saniye
}

export function sessionSecret(): string | undefined {
  const s = process.env.SESSION_SECRET;
  return s && s.length > 0 ? s : undefined;
}

export function authEnabled(): boolean {
  return sessionSecret() !== undefined;
}

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** İmzalı oturum token'ı üretir (route handler, login sonrası). TTL kısa (iptal + uzak doğrulama var). */
export async function createSession(
  user: Omit<SessionPayload, 'exp'>,
  ttlSec = SESSION_TTL_SEC,
): Promise<string> {
  const secret = sessionSecret();
  if (!secret) throw new Error('SESSION_SECRET tanımlı değil');
  const payload: SessionPayload = { ...user, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, data as BufferSource));
  return `${b64url(data)}.${b64url(sig)}`;
}

/** Token'ı doğrular (imza + süre) → payload veya null. */
export async function verifySession(token: string | undefined): Promise<SessionPayload | null> {
  const secret = sessionSecret();
  if (!secret || !token) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  let data: Uint8Array;
  let sig: Uint8Array;
  try {
    data = fromB64url(token.slice(0, dot));
    sig = fromB64url(token.slice(dot + 1));
  } catch {
    return null;
  }
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify('HMAC', key, sig as BufferSource, data as BufferSource);
  if (!valid) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

/**
 * Uzak oturum doğrulama (middleware): admin API'de var + aktif + tokenVersion eşleşiyor mu.
 * Böylece pasifleştirilen/silinen/parolası sıfırlanan admin ANINDA erişimini kaybeder (§8).
 * API erişilemezse 'error' → FAIL-OPEN (imzalı token yine geçerli; iptal gecikir, kilitlenme olmaz).
 */
export async function validateSessionRemote(
  sub: string,
  ver: number,
): Promise<'valid' | 'invalid' | 'error'> {
  const url = process.env.API_URL;
  const token = process.env.ADMIN_TOKEN;
  if (!url || !token) return 'error';
  try {
    // Zaman aşımı ŞART: middleware her istekte bunu bekler. API "kapalı" değil de
    // "asılı" ise (DB kilidi, havuz tükenmesi, yarı-açık TCP) fetch reddetmez de
    // çözülmez de → tüm panel donar. 1.5sn sonra AbortError → catch → 'error' → fail-open.
    const res = await fetch(`${url}/v1/admin/auth/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({ sub, ver }),
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return 'error';
    const data = (await res.json()) as { valid: boolean };
    return data.valid ? 'valid' : 'invalid';
  } catch {
    return 'error';
  }
}
