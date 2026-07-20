/**
 * Admin UI auth — env-gated (varsayılan KAPALI, lockout riski yok).
 * ADMIN_UI_PASSWORD set edilmezse gate devre dışı (mevcut davranış).
 * Set edilirse: /login zorunlu; oturum httpOnly cookie'de imzalı token.
 *
 * Edge-uyumlu (crypto.subtle / TextEncoder) — middleware VE server action kullanır.
 * NOT: 'server-only' YOK (middleware import eder).
 */
export const SESSION_COOKIE = 'admin_session';
const APP_SALT = 'jetlisans-admin-session-v1';

export function authPassword(): string | undefined {
  const p = process.env.ADMIN_UI_PASSWORD;
  return p && p.length > 0 ? p : undefined;
}

export function authEnabled(): boolean {
  return authPassword() !== undefined;
}

/** Parolayı statik salt ile SHA-256'lar → oturum cookie değeri (parola cookie'de tutulmaz). */
export async function sessionTokenFor(password: string): Promise<string> {
  const data = new TextEncoder().encode(`${password}::${APP_SALT}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Sabit-zamanlı string karşılaştırma (timing sızıntısını azaltır). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
