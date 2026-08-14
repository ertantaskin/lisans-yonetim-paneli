import * as Sentry from '@sentry/node';
import { sanitizeLogUrl } from './log-redact';

/**
 * Sentry hata izleme — env-gated, VARSAYILAN KAPALI (§16 gözlem). SENTRY_DSN verilmezse
 * Sentry.init HİÇ çağrılmaz → SDK dormant kalır: hiçbir ağ çağrısı / instrumentation / process
 * kancası kurulmaz, sistem Sentry'siz tam çalışır. DSN kullanıcı SIRRIDIR — üretilmez;
 * aktivasyon kullanıcının adımıdır (AI / SMTP / Telegram env-gate deseniyle birebir aynı).
 *
 * main.ts'te reflect-metadata'dan hemen SONRA, uygulama modüllerinden ÖNCE import edilir
 * (Sentry v10 önerisi; yalnız hata izleyip trace örneklemesini kapattığımız için sıra
 * kritik değil ama öneriye uyulur).
 */
const dsn = process.env.SENTRY_DSN?.trim();

/** Sentry etkin mi? (DSN verildiyse). Yardımcı/filtre bununla no-op'a düşer. */
export const sentryEnabled = Boolean(dsn);

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV || 'development',
    // Yalnız HATA izleme: performans (trace) örneklemesi KAPALI → ek yük/maliyet/gürültü yok.
    tracesSampleRate: 0,
    // PII GÖNDERME: istek gövdesi, IP, çerez, kullanıcı bilgisi Sentry'ye GİTMEZ —
    // payload/anahtar sızıntısı riskini kesin keser (§9 redaksiyon / KVKK uyumlu). Yalnız
    // hata tipi + mesajı + stack trace iletilir.
    sendDefaultPii: false,
    /**
     * SIR/PII SON KAPISI (denetim D6 — savunma-derinliği).
     *
     * `sendDefaultPii:false` çerez/IP/kullanıcıyı keser AMA `@sentry/node` varsayılan
     * entegrasyonları bir 5xx olayına istek BAĞLAMINI (`event.request.url`,
     * `event.request.headers`) yine de iliştirebilir. Bu panelde ikisi de sır taşır:
     *   · URL → `?search=<TAM LİSANS ANAHTARI>` (envanter araması tam anahtar kabul eder)
     *     ve `/v1/admin/customers/<eposta>` (PII, §9/KVKK),
     *   · başlıklar → `x-admin-token` (tam panel yetkisi), `x-admin-actor`/`x-admin-role`,
     *     site-facing yolda `x-signature`.
     * Bugün `SENTRY_DSN` boş olduğu için tam no-op; ama DSN prod'da AÇILDIĞI gün bu değerler
     * üçüncü tarafa çıkardı. Kapı burada, init'in İÇİNDE — açma kararı ile koruma aynı yerde.
     *
     * URL, erişim logunun kullandığı AYNI yardımcıdan (`sanitizeLogUrl`) geçer → tek doğruluk
     * kaynağı: hassas parametre listesi orada büyüdükçe burası kendiliğinden uyar.
     * Başlıklar TÜMDEN silinir (beyaz liste yerine): tanı değeri düşük, sızıntı riski yüksek
     * ve "hangi başlık güvenli" kararı zamanla eskiyen bir listedir.
     */
    beforeSend(event) {
      const req = event.request;
      if (req) {
        if (typeof req.url === 'string') req.url = sanitizeLogUrl(req.url);
        // Sorgu dizesi ayrı alanda da gelebilir (Sentry `query_string`) → aynı muamele.
        if (typeof req.query_string === 'string') {
          req.query_string = sanitizeLogUrl(`?${req.query_string}`).replace(/^\?/, '');
        }
        delete req.headers;
        delete req.cookies;
        // Gövde: lisans payload'ı / parola / api_key taşıyabilir → asla gönderilmez.
        delete req.data;
      }
      return event;
    },
  });
}

/**
 * Bir hatayı Sentry'ye iletir — YALNIZ etkinse; değilse tam no-op. (Init edilmemiş SDK'da
 * captureException zaten no-op'tur; erken çıkış açık niyet + sıfır maliyet sağlar.)
 */
export function captureError(err: unknown): void {
  if (!sentryEnabled) return;
  Sentry.captureException(err);
}
