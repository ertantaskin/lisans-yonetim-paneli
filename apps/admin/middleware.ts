import { NextResponse, type NextRequest } from 'next/server';
import { authPassword, sessionTokenFor, SESSION_COOKIE, safeEqual } from './lib/auth';

/**
 * Auth gate. ADMIN_UI_PASSWORD set DEĞİLSE hiçbir şey yapmaz (gate kapalı).
 * Set ise: geçerli oturum cookie'si olmayan istekleri /login'e yönlendirir.
 */
export async function middleware(req: NextRequest) {
  const pw = authPassword();
  if (!pw) return NextResponse.next(); // gate kapalı

  const { pathname, search } = req.nextUrl;
  // Login/logout uçları gate'ten muaf (aksi halde giriş POST'u bounce olur).
  if (pathname === '/login' || pathname === '/api/login' || pathname === '/api/logout') {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(SESSION_COOKIE)?.value ?? '';
  const expected = await sessionTokenFor(pw);
  if (cookie && safeEqual(cookie, expected)) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  if (pathname !== '/') url.searchParams.set('from', pathname + search);
  return NextResponse.redirect(url);
}

// Statik dosyalar ve dahili yollar hariç her istek gate'ten geçer.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
