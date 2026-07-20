import { NextResponse, type NextRequest } from 'next/server';
import { adminLogin } from '@/lib/api';
import { authEnabled, createSession, SESSION_COOKIE } from '@/lib/auth';

/**
 * Login — native form POST. Kimlik+parola API'de (admin_users) doğrulanır; başarılıysa
 * imzalı oturum cookie'si set edilir + 303 redirect. Standart HTTP (RSC quirk'i yok).
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const from = String(form.get('from') ?? '/');
  const to = from.startsWith('/') && !from.startsWith('//') ? from : '/';

  if (!authEnabled()) return NextResponse.redirect(new URL('/', req.url), 303); // gate kapalı

  const identifier = String(form.get('identifier') ?? '').trim();
  const password = String(form.get('password') ?? '');

  let user = null;
  try {
    user = await adminLogin(identifier, password);
  } catch {
    return NextResponse.redirect(new URL(`/login?error=api&from=${encodeURIComponent(to)}`, req.url), 303);
  }
  if (!user) {
    return NextResponse.redirect(new URL(`/login?error=1&from=${encodeURIComponent(to)}`, req.url), 303);
  }

  const token = await createSession({ sub: user.id, email: user.email, name: user.name });
  const res = NextResponse.redirect(new URL(to, req.url), 303);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}
