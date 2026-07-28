import { NextResponse, type NextRequest } from 'next/server';
import { authEnabled, verifySession, validateSessionCached, SESSION_COOKIE } from './lib/auth';

/**
 * Auth gate. SESSION_SECRET set DEĞİLSE hiçbir şey yapmaz (gate kapalı, lockout riski yok).
 * Set ise: geçerli imzalı oturumu olmayan istekleri /login'e yönlendirir.
 */
export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Kök yolu → /pending: TEMİZ server 307. (app/page.tsx redirect'i async root layout
  // stream'e başladığından meta-refresh'e düşüyordu → login sonrası boş kabuk. Middleware
  // render'dan ÖNCE çalışır, gerçek yönlendirme verir.) Auth açık/kapalı fark etmez.
  if (pathname === '/') {
    const url = req.nextUrl.clone();
    url.pathname = '/pending';
    url.search = '';
    return NextResponse.redirect(url);
  }

  if (!authEnabled()) {
    // Auth kapalıyken /login gereksiz; login/page.tsx'in redirect('/')'ı async root
    // layout stream'i yüzünden meta-refresh'e düşer (kök '/' ile aynı sınıf bug).
    // Render'dan önce middleware'de temiz 307 ver.
    if (pathname === '/login') {
      const url = req.nextUrl.clone();
      url.pathname = '/pending';
      url.search = '';
      return NextResponse.redirect(url);
    }
    return NextResponse.next(); // gate kapalı
  }

  // Login/logout uçları gate'ten muaf (aksi halde giriş POST'u bounce olur).
  if (pathname === '/login' || pathname === '/api/login' || pathname === '/api/logout') {
    return NextResponse.next();
  }

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (session) {
    // Uzak iptal kontrolü: admin pasif/silinmiş/tokenVersion değişmişse erişimi kes.
    // API erişilemezse ('error') fail-open — imzalı token yeterli, kilitlenme yok.
    // Kısa-ömürlü önbellekli (5sn): navigasyon/prefetch bursts API'yi yormaz, iptal ≤5sn yansır.
    const state = await validateSessionCached(session.sub, session.ver);
    if (state !== 'invalid') return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  if (pathname !== '/') url.searchParams.set('from', pathname + search);
  return NextResponse.redirect(url);
}

/**
 * Gate kapsamı: Next'in kendi ürettiği statik varlıklar ve favicon DIŞINDA her istek
 * oturum kapısından geçer.
 *
 * DARALTILDI (denetim bulgusu): eskiden desen ".svg/.png/.jpg/…" ile BİTEN TÜM yolları
 * muaf tutuyordu. Muafiyet UZANTIYA bakıyordu, dizine değil — yani ileride eklenecek
 * `/reports/export.svg` ya da `/api/qr/site.png` gibi HERHANGİ bir rota, adı öyle bittiği
 * için sessizce korumasız kalırdı (uzantı = yetki kararı: kırılgan). Artık muafiyet üç
 * SABİT yola indirildi. `public/` şu an boş; oraya statik dosya eklenirse ya `_next`
 * üzerinden `import` edilmeli ya da buraya AÇIKÇA sabit bir önek (ör. `assets/`)
 * eklenmelidir — uzantı temelli genel muafiyet geri getirilmemelidir.
 *
 * OTURUM AKIŞI KORUNUR: `/login`, `/api/login`, `/api/logout` bu desene GİRER (yani
 * middleware onlar için de çalışır) — tıpkı eskisi gibi, çünkü hiçbiri yukarıdaki üç
 * yoldan biri değil ve eski desende de uzantıyla bitmiyorlardı. Bu yollara özgü muafiyet
 * zaten fonksiyonun İÇİNDE (yukarıda) yapılıyor: auth kapalıyken `/login` → `/pending`
 * yönlendirmesi, auth açıkken üçü de `NextResponse.next()` ile gate'ten muaf. Yani giriş
 * POST'u bounce olmaz, davranış birebir aynı kalır.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
