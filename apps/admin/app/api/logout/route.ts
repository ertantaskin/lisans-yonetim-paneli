import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { apiPost } from '@/lib/api';

/**
 * Logout — native form POST. Cookie'yi siler ve /login'e döner (303, GÖRELİ Location).
 * NOT: göreli Location ŞART — NextResponse.redirect(new URL(..., req.url)) Caddy arkasında
 * iç host/yanlış protokol üretip "çıkış yönlendirmiyor" bug'ına yol açar (login ile aynı sınıf).
 */
/**
 * CSRF: cross-site zorla-logout'u engelle — Origin host'u istek Host'uyla uyuşmalı.
 *
 * DENETİM D5 — "Origin yoksa izin ver" KALDIRILDI: POST'ta Origin yokluğu meşru bir tarayıcı
 * davranışı değildir. Origin yoksa YEDEK kapı olarak Fetch Metadata'ya bakılır: `same-origin`
 * (aynı origin'den form/fetch) ve `none` (doğrudan navigasyon) kabul, diğer her şey (ve iki
 * başlığın da yokluğu) RED. Bu iki başlığı saldırgan sayfa ayarlayamaz — tarayıcı koyar.
 *
 * (Kural login/route.ts ile BİREBİR aynıdır ve orada da yazılıdır; Next route handler dosyaları
 *  yalnız HTTP metot export'larına izin verdiği için paylaşılan bir yardımcı olarak export
 *  EDİLEMEZ, bilinçli kopyadır — ikisi birlikte değiştirilmelidir.)
 */
function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) {
    const fetchSite = req.headers.get('sec-fetch-site');
    return fetchSite === 'same-origin' || fetchSite === 'none';
  }
  try {
    return new URL(origin).host === req.headers.get('host');
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return new NextResponse('forbidden', { status: 403 });
  // Gerçek oturum iptali (denetim P3): cookie silmek YETMEZ — çalınmış bir token 12sa TTL boyunca
  // geçerli kalırdı. Logout'ta admin'in tokenVersion'ını +1 yap (API) → token ANINDA geçersizleşir
  // (tüm cihazlar). Best-effort: API erişilemezse logout yine tamamlanır (cookie silinir).
  try {
    const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
    if (session) await apiPost('/v1/admin/auth/logout', { sub: session.sub });
  } catch {
    /* best-effort — logout akışını asla bozma */
  }
  const res = new NextResponse(null, { status: 303, headers: { location: '/login' } });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
