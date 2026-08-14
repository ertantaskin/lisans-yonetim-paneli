import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sessionSecret } from '../../lib/auth';

/**
 * İKİ FAKTÖRLÜ GİRİŞİN ARA DURUMU — "parolayı geçti, kodu bekliyor" beklet-token'ı.
 *
 * NEDEN AYRI BİR TOKEN: ikinci adımda kullanıcı yalnız 6 haneli kodu gönderir; sunucunun
 * "bu kod HANGİ hesap için" bilgisine ihtiyacı vardır. Parolayı gizli alanda taşımak (ya da
 * ikinci adımda yeniden sormak) parolayı gereksizce dolaştırırdı. Bunun yerine, parola
 * doğrulandıktan SONRA yalnız admin kimliğini taşıyan, 5 dakikalık, imzalı bir çerez kurulur.
 *
 * BU TOKEN ERİŞİM VERMEZ: middleware yalnız `admin_session` çerezine bakar; ayrıca imza
 * anahtarı SESSION_SECRET'ten AYRI TÜRETİLİR (`totp-pending-v1` etiketi) → bir beklet-token'ı
 * ASLA geçerli bir oturum token'ı olarak doğrulanamaz (ve tersi). Oturum çerezi yalnız ikinci
 * adım geçilince verilir — yarım oturum yoktur.
 */
export const PENDING_COOKIE = 'admin_totp_pending';

/** Beklet-token ömrü: kodu girmeye fazlasıyla yeter, çalınırsa kısa sürede işe yaramaz olur. */
export const PENDING_TTL_SEC = 300;

interface PendingPayload {
  sub: string;
  /** Alan-ayrımı: oturum payload'ıyla karışmasın (imza anahtarı da zaten farklı). */
  typ: 'totp_pending';
  exp: number;
}

/** Oturum imzasından TÜRETİLMİŞ ayrı anahtar — iki token sınıfı birbirinin yerine geçemez. */
function pendingKey(): Buffer {
  const secret = sessionSecret();
  if (!secret) throw new Error('SESSION_SECRET tanımlı değil');
  return createHmac('sha256', secret).update('totp-pending-v1').digest();
}

function sign(data: string): string {
  return createHmac('sha256', pendingKey()).update(data).digest('base64url');
}

/** Parola adımı GEÇİLDİKTEN sonra çağrılır. */
export function createPendingToken(sub: string): string {
  const payload: PendingPayload = {
    sub,
    typ: 'totp_pending',
    exp: Math.floor(Date.now() / 1000) + PENDING_TTL_SEC,
  };
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${data}.${sign(data)}`;
}

/** İmza + tür + süre doğrular. Hatalı/süresi geçmiş token → null (çağıran 1. adıma döner). */
export function verifyPendingToken(token: string | undefined): { sub: string } | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expected: string;
  try {
    expected = sign(data);
  } catch {
    return null; // SESSION_SECRET yok/zayıf → auth zaten kapalı
  }
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: PendingPayload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as PendingPayload;
  } catch {
    return null;
  }
  if (payload.typ !== 'totp_pending') return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
  return { sub: payload.sub };
}
