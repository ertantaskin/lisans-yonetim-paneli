import 'server-only';
import { cookies } from 'next/headers';
import { authEnabled, verifySession, SESSION_COOKIE, type SessionPayload } from './auth';

/** Sunucu-taraflı: geçerli oturumdaki admin (yoksa/auth kapalıysa null). */
export async function getSessionUser(): Promise<SessionPayload | null> {
  if (!authEnabled()) return null;
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}

/**
 * Owner yetkisi kontrolü. Auth KAPALIYSA (SESSION_SECRET yok → panel zaten herkese açık)
 * true döner (tutarlılık). Auth AÇIKSA yalnız role='owner' true.
 */
export async function isOwner(): Promise<boolean> {
  if (!authEnabled()) return true;
  const user = await getSessionUser();
  return user?.role === 'owner';
}

/**
 * Audit için eylemi yapan admin'in kimliği. apiPost/apiSend'e 3. argüman olarak
 * geçilir → `x-admin-actor` başlığı → API @AdminActor → audit_log.actor.
 * Auth kapalıysa (veya oturum yok) 'panel:admin' (sistem/legacy).
 */
export async function getActor(): Promise<string> {
  const user = await getSessionUser();
  return user ? `admin:${user.email}` : 'panel:admin';
}

/**
 * Doğrulanmış oturumun rolü ('owner' | 'admin') veya null (auth kapalı / oturum yok).
 * YAZMA API çağrılarında `x-admin-role` başlığıyla iletilir (lib/api.ts) → API OwnerGuard
 * owner-only uçları tek bir eksik Next-katmanı isOwner() kontrolünde bile korur (savunma-derinliği).
 */
export async function getSessionRole(): Promise<string | null> {
  const user = await getSessionUser();
  return user?.role ?? null;
}

/**
 * Aktör + rolü TEK oturum okumasıyla döndürür (apiGet her okumada ikisini de iletir: audit
 * attribution [denetim A2] + düz-metin/maskeli sunum kararı [denetim A1]). Ayrı ayrı çağırmak
 * getSessionUser'ı iki kez (2× HMAC doğrulama) çalıştırırdı.
 */
export async function getActorAndRole(): Promise<{ actor: string; role: string | null }> {
  const user = await getSessionUser();
  return { actor: user ? `admin:${user.email}` : 'panel:admin', role: user?.role ?? null };
}
