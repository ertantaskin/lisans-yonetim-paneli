import { NextResponse, type NextRequest } from 'next/server';
import { authPassword, sessionTokenFor, SESSION_COOKIE, safeEqual } from '@/lib/auth';

/**
 * Login — native form POST. Standart HTTP Set-Cookie + 303 redirect (RSC action
 * quirk'lerinden bağımsız, her ortamda güvenilir). Middleware /api/login'i muaf tutar.
 */
export async function POST(req: NextRequest) {
  const pw = authPassword();
  const form = await req.formData();
  const from = String(form.get('from') ?? '/');
  const to = from.startsWith('/') && !from.startsWith('//') ? from : '/';

  if (!pw) return NextResponse.redirect(new URL('/', req.url), 303); // gate kapalı

  const input = String(form.get('password') ?? '');
  const [inputToken, expected] = await Promise.all([sessionTokenFor(input), sessionTokenFor(pw)]);
  if (!safeEqual(inputToken, expected)) {
    return NextResponse.redirect(
      new URL(`/login?error=1&from=${encodeURIComponent(to)}`, req.url),
      303,
    );
  }

  const res = NextResponse.redirect(new URL(to, req.url), 303);
  res.cookies.set(SESSION_COOKIE, expected, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}
