import * as Sentry from '@sentry/node';

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
