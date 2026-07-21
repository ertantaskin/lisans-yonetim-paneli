import { Global, Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';

/**
 * RateLimitModule — Redis tabanlı hız sınırını uygulama geneline sağlar (§4/§16).
 *
 * @Global: her tüketici modül (updates/ai/onboarding …) ayrıca import etmeden RateLimitService'i
 * enjekte edebilsin. REDIS token'ı RedisModule (@Global) tarafından zaten global sağlandığından
 * burada ayrıca import gerekmez.
 */
@Global()
@Module({
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class RateLimitModule {}
