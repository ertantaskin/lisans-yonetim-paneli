/**
 * Admin UI oturum yönetimi — çoklu admin (§8). Kimlik doğrulama API'de (admin_users);
 * burada yalnız imzalı OTURUM cookie'si üretilir/doğrulanır.
 *
 * Oturum token: `<base64url(payload)>.<base64url(HMAC-SHA256)>` — SESSION_SECRET ile imzalı.
 * Edge-uyumlu (crypto.subtle / btoa / atob) → hem middleware (edge) hem route handler (node).
 * `SESSION_SECRET` set DEĞİLSE auth KAPALI (gate devre dışı, lockout riski yok).
 */
export const SESSION_COOKIE = 'admin_session';

export interface SessionPayload {
  sub: string; // admin id
  email: string;
  name: string;
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

/** İmzalı oturum token'ı üretir (route handler, login sonrası). */
export async function createSession(
  user: Omit<SessionPayload, 'exp'>,
  ttlSec = 60 * 60 * 24 * 7,
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
