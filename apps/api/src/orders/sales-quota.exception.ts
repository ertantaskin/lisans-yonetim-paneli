import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Sert günlük satış kotası (§5/§8 salesDailyQuota) aşıldı → 429 TOO_MANY_REQUESTS.
 * OrdersService.createOrder (site advisory-lock altında, idempotency lookup'ından SONRA)
 * fırlatır; OrdersController `retryAfterSec`'ten `Retry-After` başlığını set eder ve
 * OrdersService catch'i best-effort `security_events` (quota_exceeded) yazar.
 *
 * Dinamik kota (dynamicQuotaEnabled) bu istisnayı fırlatMAZ — o yol REDDETMEZ, siparişi
 * held_for_review ile KABUL eder (insan onayı, §15). Bu istisna yalnız SERT tavan içindir.
 */
export class SalesQuotaExceededException extends HttpException {
  constructor(
    readonly todayCount: number,
    readonly limit: number,
    readonly retryAfterSec: number,
  ) {
    super('Günlük satış kotası aşıldı', HttpStatus.TOO_MANY_REQUESTS);
  }
}
