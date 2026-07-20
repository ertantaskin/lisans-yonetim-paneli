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
