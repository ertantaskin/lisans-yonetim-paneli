import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth';

/** Logout — native form POST. Cookie'yi siler ve /login'e döner. */
export async function POST(req: NextRequest) {
  // CSRF: cross-site zorla-logout'u engelle (Origin host'u Host ile uyuşmalı; yoksa izin).
  const origin = req.headers.get('origin');
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === req.headers.get('host');
    } catch {
      ok = false;
    }
    if (!ok) return new NextResponse('forbidden', { status: 403 });
  }
  const res = NextResponse.redirect(new URL('/login', req.url), 303);
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
