import type { NextConfig } from 'next';

// Güvenlik başlıkları (§17 sertleştirme). CSP artık ENFORCE ediliyor
// (Report-Only DEĞİL): böylece frame-ancestors/object-src/base-uri/form-action
// gibi değerli direktifler gerçekten uygulanır (clickjacking, <base> ele geçirme,
// obje/eklenti enjeksiyonu, exfil form-post daralır).
//
// script-src'te 'unsafe-inline' + 'unsafe-eval' Next 15 App Router GEREĞİ tutulur:
// inline hidrasyon başlatıcısı + RSC flight + bazı runtime chunk'ları bunları ister;
// kaldırılırsa uygulama kırılır. Nonce/hash tabanlı sıkılaştırma AYRI bir iş olarak
// ertelendi (ayrı görev). style-src'te 'unsafe-inline' de Next inline style'ları için.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Ortak güvenlik başlıkları. HSTS yalnız üretimde (yerelde http:// üzerinden
// çalışırken tarayıcıyı HTTPS'e kilitlememek için).
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Content-Security-Policy', value: csp },
  ...(process.env.NODE_ENV === 'production'
    ? [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=63072000; includeSubDomains; preload',
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Standalone çıktı — ince Docker imajı (§1 dağıtım). Yalnız Docker/Linux'ta
  // açılır: Windows'ta standalone symlink'leri EPERM verir (geliştirici modu ister).
  output: process.env.NEXT_OUTPUT_STANDALONE === '1' ? 'standalone' : undefined,
  // Monorepo ortak paketi Next tarafında transpile edilir.
  transpilePackages: ['@lisans/shared'],
  eslint: { ignoreDuringBuilds: true },
  // Server Action gövde tavanı. Varsayılan 1 MB'tır ve aşıldığında Next OPAK bir hata
  // fırlatır (kullanıcı ne olduğunu anlamaz). /releases sürüm yayınlama formu dosya
  // yüklediği için tavanı 2 MB'a çekiyoruz: yanlış/büyük dosya seçen kullanıcı artık
  // Next'in opak hatası yerine action'ın kendi TÜRKÇE mesajını görüyor
  // ("Zip çok büyük: … En çok 700 KB").
  // NOT: GERÇEK sınır yine API tarafındaki Fastify bodyLimit'idir (1 MiB,
  // apps/api/src/main.ts) — bu yüzden releases/actions.ts 700 KB'ta keser; buradaki
  // 2 MB yalnız "anlaşılır hata verebilmek" için bırakılan paydır, gerçek kapasite değil.
  experimental: {
    serverActions: { bodySizeLimit: '2mb' },
  },
  // Tüm rotalara güvenlik başlıkları uygula.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
