import { NextResponse, type NextRequest } from 'next/server';
import { apiRaw } from '@/lib/api';
import { authEnabled, createSession, SESSION_COOKIE, SESSION_TTL_SEC } from '@/lib/auth';
import {
  PENDING_COOKIE,
  PENDING_TTL_SEC,
  createPendingToken,
  verifyPendingToken,
} from '@/app/login/pending';

/**
 * CSRF/login-CSRF koruması: tarayıcı cross-site bir POST navigasyonunda Origin gönderir.
 * Origin host'u istek Host'uyla uyuşmuyorsa reddet (session fixation engellenir).
 *
 * DENETİM D5 — "Origin yoksa geçir" KALDIRILDI: POST'ta Origin YOKLUĞU meşru bir tarayıcı
 * davranışı değildir (modern tarayıcılar form POST'unda da gönderir); açık bırakmak, kalan tek
 * savunması `sameSite:'lax'` çerezi olan gereksiz bir kapıydı.
 *
 * YEDEK KAPI (`Sec-Fetch-Site`): Origin'i soyan egzotik bir proxy meşru girişi KİLİTLEMESİN diye,
 * Origin yoksa Fetch Metadata'ya bakılır — `same-origin` (aynı origin'den form/fetch) ve `none`
 * (adres çubuğuna yazılan/doğrudan navigasyon) kabul edilir; `cross-site`/`same-site` reddedilir.
 * Her ikisi de yoksa reddedilir (bunlar da yalnız tarayıcı-dışı istemcide birlikte eksik olur).
 * Yedek kapı bilinçli olarak Origin'den GEVŞEK değildir: iki başlık da saldırgan sayfa tarafından
 * ayarlanamayan, tarayıcının koyduğu başlıklardır.
 */
// (EXPORT EDİLMEZ: Next route handler dosyaları yalnız HTTP metot export'larına izin verir;
//  logout aynı mantığı kendi dosyasında birebir taşır.)
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

/** API'nin döndürdüğü admin kaydı (yalnız oturuma yazılan alanlar). */
interface LoginUser {
  id: string;
  email: string;
  name: string;
  role: string;
  tokenVersion: number;
}

/**
 * Oturum çerezini basıp hedefe yönlendirir + beklet-çerezini SİLER.
 * ÇEREZ YALNIZ BURADAN verilir → "parolayı geçti ama kodu girmedi" durumunda oturum oluşmaz.
 */
function grantSession(to: string, token: string): NextResponse {
  const res = seeOther(to);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SEC, // token exp ile aynı → "geçerli görünen ama dolmuş" cookie yok
  });
  // Ara durum tüketildi; kalırsa ikinci adım yeniden oynatılabilirdi.
  res.cookies.set(PENDING_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}

/**
 * Login — native form POST. Kimlik+parola API'de (admin_users) doğrulanır; başarılıysa
 * imzalı oturum cookie'si set edilir + 303 (göreli) redirect. Standart HTTP (RSC quirk'i yok).
 *
 * İKİ ADIM (TOTP): 1) kimlik+parola → API `totpRequired` derse OTURUM AÇILMAZ, yalnız kısa
 * ömürlü imzalı beklet-çerezi kurulur ve `/login?step=totp`e yönlendirilir; 2) kod → API
 * `/auth/login/totp`. Oturum çerezi yalnız 2. adım başarılıysa verilir.
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

  // ── 2. ADIM: doğrulama kodu ────────────────────────────────────────────────
  if (String(form.get('step') ?? '') === 'totp') {
    const pending = verifyPendingToken(req.cookies.get(PENDING_COOKIE)?.value);
    if (!pending) {
      // Süre doldu / çerez yok → 1. adıma dön (sayfa kendi mesajını gösterir).
      return seeOther(`/login?step=totp&from=${encodeURIComponent(to)}`);
    }
    const code = String(form.get('code') ?? '').trim();
    if (code.length === 0 || code.length > 24) {
      return seeOther(`/login?step=totp&error=totp&from=${encodeURIComponent(to)}`);
    }
    let user: LoginUser | null = null;
    try {
      const res = await apiRaw('POST', '/v1/admin/auth/login/totp', {
        body: { sub: pending.sub, code },
      });
      if (res.ok) {
        user = ((await res.json()) as { user: LoginUser }).user;
      } else if (res.status !== 401 && res.status !== 429) {
        return seeOther(`/login?step=totp&error=api&from=${encodeURIComponent(to)}`);
      }
    } catch {
      return seeOther(`/login?step=totp&error=api&from=${encodeURIComponent(to)}`);
    }
    // 401/429 → aynı generik mesaj (kilitli mi yanlış mı ayırt edilmez; kova zaten API'de).
    if (!user) return seeOther(`/login?step=totp&error=totp&from=${encodeURIComponent(to)}`);
    return grantSession(to, await createSession({ ...toSession(user) }));
  }

  // ── 1. ADIM: kimlik + parola ───────────────────────────────────────────────
  const identifier = String(form.get('identifier') ?? '').trim();
  const password = String(form.get('password') ?? '');

  // Kimlik üst sınırı API'deki ZodBody ile aynı (200). Aşan istek API'ye hiç gitmez —
  // hiçbir gerçek hesap bu aralığın dışında olamayacağı için doğrudan "geçersiz kimlik".
  if (identifier.length === 0 || identifier.length > 200) {
    return seeOther(`/login?error=1&from=${encodeURIComponent(to)}`);
  }

  let user: LoginUser | null = null;
  let totpSub: string | null = null;
  try {
    const res = await apiRaw('POST', '/v1/admin/auth/login', {
      body: { identifier, password },
    });
    if (res.ok) {
      const data = (await res.json()) as {
        user?: LoginUser;
        totpRequired?: boolean;
        sub?: string;
      };
      if (data.totpRequired && data.sub) totpSub = data.sub;
      else if (data.user) user = data.user;
    } else if (res.status !== 401 && res.status !== 429) {
      // 401/429 dışı (5xx, ağ, gövde hatası) → "sunucuya ulaşılamadı".
      return seeOther(`/login?error=api&from=${encodeURIComponent(to)}`);
    }
  } catch {
    return seeOther(`/login?error=api&from=${encodeURIComponent(to)}`);
  }

  // TOTP açık: OTURUM YOK. Yalnız hangi hesabın kod beklediğini taşıyan imzalı ara çerez.
  if (totpSub) {
    const res = seeOther(`/login?step=totp&from=${encodeURIComponent(to)}`);
    res.cookies.set(PENDING_COOKIE, createPendingToken(totpSub), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: PENDING_TTL_SEC,
    });
    return res;
  }

  if (!user) {
    return seeOther(`/login?error=1&from=${encodeURIComponent(to)}`);
  }

  return grantSession(to, await createSession({ ...toSession(user) }));
}

/** API kullanıcı kaydı → oturum payload'ı (tek yerde; iki giriş yolu da bunu kullanır). */
function toSession(user: LoginUser) {
  return {
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    ver: user.tokenVersion,
  };
}
