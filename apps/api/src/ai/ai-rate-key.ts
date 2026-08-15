/**
 * AI uçlarının hız-sınırı kova anahtarı — TEK KAYNAK.
 *
 * KOVA ANAHTARI = ADMİN AKTÖRÜ, IP DEĞİL. Panel uçlarına istekler Next admin sunucusu üzerinden
 * PROXY'lenir → API'nin gördüğü IP tüm operatörler için AYNIDIR (tek Caddy/Next hop). "IP başına"
 * sınır bu yüzden pratikte TEK GLOBAL kovaya çöker: bir operatör dakikada 20 triyaj yapınca
 * diğer TÜM operatörler 429 alır. Aktör kimliği (`x-admin-actor` — ADMIN_TOKEN ile aynı güven
 * düzeyi, bkz. AdminActor) kovayı gerçek kullanıcı başına ayırır. Aktör yoksa/varsayılansa
 * ('panel:admin' — auth KAPALI kurulum ya da sistem çağrısı) IP'ye geri düşülür; o kurulumda
 * zaten tek operatör vardır ve panel ADMIN_TOKEN ile korunur.
 *
 * NEDEN AYRI DOSYA: bu düzeltme önce yalnız `ai-report.controller.ts` içinde yapılmış ve orada
 * "tek kaynak — diğer AI uçları da kullanmalı" diye işaretlenmişti, ama taşınmamıştı; triyaj ucu
 * IP kovasında kalmıştı. Ortak dosya, aynı kusurun bir uçta yaşamaya devam etmesini engeller.
 */

/** Dakikada izin verilen AI isteği (aktör başına; aktör yoksa IP başına). */
export const AI_RL_MAX = 20;
export const AI_RL_WINDOW_SEC = 60;

export function aiRateKey(scope: string, actor: string | undefined, ip: string): string {
  const known = actor && actor !== 'panel:admin' ? actor : null;
  return known ? `ai:${scope}:actor:${known}` : `ai:${scope}:ip:${ip}`;
}
