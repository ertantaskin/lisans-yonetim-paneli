import { NextResponse, type NextRequest } from 'next/server';
import { adminLogin } from '@/lib/api';
import { authEnabled, createSession, SESSION_COOKIE, SESSION_TTL_SEC } from '@/lib/auth';

/**
 * CSRF/login-CSRF koruması: tarayıcı cross-site bir POST navigasyonunda Origin gönderir.
 * Origin host'u istek Host'uyla uyuşmuyorsa reddet (session fixation / zorla logout engellenir).
 * Origin yoksa (bazı aynı-origin durumları) izin ver — meşru girişleri kırmayalım.
 */
function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.get('host');
  } catch {
    return false;
  }
}

/**
 * 303 See Other — GÖRELİ Location ile yönlendirir. NextResponse.redirect MUTLAK URL ister ve
 * bunu req.url'den kurar; ancak Caddy (reverse_proxy) arkasında req.url iç host/yanlış protokol
 * (http://admin:3000…) taşır → Location tarayıcının erişemeyeceği bir adrese çıkar ve login/logout
 * "yönlendirmiyor, sayfada kalıyor" bug'ı oluşur. GÖRELİ Location ise tarayıcının GERÇEK istek
 * URL'ine (dış https panel) göre çözülür → her zaman doğru host+protokol. Cookie yine bindirilebilir.
 */
function seeOther(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location: path } });
}

/**
 * Login — native form POST. Kimlik+parola API'de (admin_users) doğrulanır; başarılıysa
 * imzalı oturum cookie'si set edilir + 303 (göreli) redirect. Standart HTTP (RSC quirk'i yok).
 */
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return new NextResponse('forbidden', { status: 403 });
  const form = await req.formData();
  const from = String(form.get('from') ?? '/pending');
  // Açık yönlendirme koruması: `from`'u origin'e göre çöz; yalnız AYNI origin'e izin ver.
  // (/\evil.com gibi ters-eğik-çizgi authority kaçışlarını da kapatır.) Yalnız path+search
  // kullanılır (göreli Location) → dış origin sızmaz, proxy proto/host sorunu da yaşanmaz.
  let to = '/pending';
  try {
    const origin = new URL(req.url).origin;
    const u = new URL(from, origin);
    if (u.origin === origin) to = u.pathname + u.search;
  } catch {
    to = '/pending';
  }

  if (!authEnabled()) return seeOther('/pending'); // gate kapalı

  const identifier = String(form.get('identifier') ?? '').trim();
  const password = String(form.get('password') ?? '');

  let user = null;
  try {
    user = await adminLogin(identifier, password);
  } catch {
    return seeOther(`/login?error=api&from=${encodeURIComponent(to)}`);
  }
  if (!user) {
    return seeOther(`/login?error=1&from=${encodeURIComponent(to)}`);
  }

  const token = await createSession({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    ver: user.tokenVersion,
  });
  const res = seeOther(to);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SEC, // token exp ile aynı → "geçerli görünen ama dolmuş" cookie yok
  });
  return res;
}
