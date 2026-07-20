import { NextResponse, type NextRequest } from 'next/server';
import { authEnabled, verifySession, validateSessionRemote, SESSION_COOKIE } from './lib/auth';

/**
 * Auth gate. SESSION_SECRET set DEĞİLSE hiçbir şey yapmaz (gate kapalı, lockout riski yok).
 * Set ise: geçerli imzalı oturumu olmayan istekleri /login'e yönlendirir.
 */
export async function middleware(req: NextRequest) {
  if (!authEnabled()) return NextResponse.next(); // gate kapalı

  const { pathname, search } = req.nextUrl;
  // Login/logout uçları gate'ten muaf (aksi halde giriş POST'u bounce olur).
  if (pathname === '/login' || pathname === '/api/login' || pathname === '/api/logout') {
    return NextResponse.next();
  }

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (session) {
    // Uzak iptal kontrolü: admin pasif/silinmiş/tokenVersion değişmişse erişimi kes.
    // API erişilemezse ('error') fail-open — imzalı token yeterli, kilitlenme yok.
    const state = await validateSessionRemote(session.sub, session.ver);
    if (state !== 'invalid') return NextResponse.next();
  }

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
