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
 * Giriş denemeleri için İKİNCİ kova (IP başına, süreç-içi). Bu uç oturum kapısından muaftır
 * (middleware /api/login'i atlar) ve Origin başlığı yoksa kabul edilir → curl ile doğrudan
 * çağrılabilir. API tarafındaki Redis kovası panelden gelen TÜM girişleri tek konteyner IP'sinde
 * görür; GERÇEK istemci IP'si yalnız burada bilinir, dolayısıyla per-istemci sınır burada kurulur.
 *
 * Sabit pencere: 10 deneme / 60 sn / IP → aşımda 429 + Retry-After. Bellek-içi Map bilinçli
 * tercihtir: admin tek süreçtir ve burada tutulan yalnız bir SAYAÇ'tır (yetkili lockout API +
 * Redis tarafındadır); süreç yeniden başlarsa en fazla birkaç deneme geri verilir.
 */
const LOGIN_RL_WINDOW_MS = 60_000;
const LOGIN_RL_MAX = 10;
const LOGIN_RL_MAX_BUCKETS = 5000; // IP rotasyonunda Map'in sınırsız büyümesini engeller

const loginBuckets = new Map<string, { count: number; resetAt: number }>();

/**
 * İstemci IP'si. Caddy (tek hop) X-Forwarded-For'un SONUNA gerçek istemciyi ekler → spoof
 * edilemeyen giriş EN SAĞDAKİdir (API'deki `trustProxy: 1` ile aynı semantik; istemcinin öne
 * eklediği sahte girişler yok sayılır). Başlık yoksa tek 'unknown' kovasında toplanır — bu
 * en kötü ihtimalle DAHA SIKI davranır, asla daha gevşek değil.
 */
function clientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (!xff) return 'unknown';
  const parts = xff
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const last = parts[parts.length - 1];
  return last ? last.slice(0, 64) : 'unknown';
}

/** Süresi dolmuş kovaları at; hâlâ doluysa en eski eklenenlerden boşalt (bellek tavanı). */
function pruneBuckets(now: number): void {
  for (const [key, b] of loginBuckets) {
    if (b.resetAt <= now) loginBuckets.delete(key);
  }
  for (const key of loginBuckets.keys()) {
    if (loginBuckets.size < LOGIN_RL_MAX_BUCKETS) break;
    loginBuckets.delete(key);
  }
}

/** Sayacı artırır; kota aşıldıysa Retry-After saniyesi, aşılmadıysa null döner. */
function loginRateLimit(ip: string): number | null {
  const now = Date.now();
  const bucket = loginBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    if (loginBuckets.size >= LOGIN_RL_MAX_BUCKETS) pruneBuckets(now);
    loginBuckets.set(ip, { count: 1, resetAt: now + LOGIN_RL_WINDOW_MS });
    return null;
  }
  bucket.count += 1;
  if (bucket.count > LOGIN_RL_MAX) return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  return null;
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

  // Hız sınırı YALNIZ auth AÇIKKEN uygulanır: gate kapalıyken bu uç zaten API'ye gitmez ve
  // davranış bugünküyle birebir aynı kalmalıdır (yukarıdaki erken dönüş bozulmaz).
  const retryAfterSec = loginRateLimit(clientIp(req));
  if (retryAfterSec !== null) {
    return new NextResponse('Çok fazla giriş denemesi. Lütfen biraz sonra tekrar deneyin.', {
      status: 429,
      headers: {
        'retry-after': String(retryAfterSec),
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }

  const identifier = String(form.get('identifier') ?? '').trim();
  const password = String(form.get('password') ?? '');

  // Kimlik üst sınırı API'deki ZodBody ile aynı (200). Aşan istek API'ye hiç gitmez —
  // hiçbir gerçek hesap bu aralığın dışında olamayacağı için doğrudan "geçersiz kimlik".
  if (identifier.length === 0 || identifier.length > 200) {
    return seeOther(`/login?error=1&from=${encodeURIComponent(to)}`);
  }

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
