import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

/**
 * RateLimitService — Redis tabanlı sabit-pencere hız sınırı (dağıtık + restart-dayanıklı).
 *
 * Bellek-içi Map limiter'ların yerini alır: çok-süreçli/çok-replikalı dağıtımda ortak sayaç
 * tutar ve süreç yeniden başlasa da pencere Redis'te yaşar. Anahtarlar `rl:` ad-alanında
 * toplanır (ör. `rl:updates:info:<ip>`), böylece nonce/BullMQ anahtarlarıyla karışmaz.
 *
 * Atomiklik: INCR + (ilk vuruşta) EXPIRE tek Lua eval'de çalışır → sayaç artışı ile TTL kurulumu
 * ayrılamaz; süreç iki adım arasında çökse bile pencere TTL'siz kalıp kalıcı sayaca dönüşmez.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Sabit-pencere kova sayacını bir artırır ve kotanın altında olup olmadığını döndürür.
   *
   * @param key    Amaç-özel anahtar parçası (ör. `updates:info:<ip>`) — servis `rl:` ekler.
   * @param limit  Pencere başına izinli maksimum vuruş.
   * @param windowSec Pencere uzunluğu (saniye); TTL yalnız ilk vuruşta kurulur.
   * @returns true = izin ver (sayaç ≤ limit); false = kota aşıldı (çağıran 429 üretmeli).
   */
  async hit(key: string, limit: number, windowSec: number): Promise<boolean> {
    try {
      // INCR ile artır; sonuç 1 ise (pencerenin ilk vuruşu) TTL kur. Tek Lua eval → atomik.
      const count = (await this.redis.eval(
        HIT_SCRIPT,
        1,
        `rl:${key}`,
        String(windowSec),
      )) as number;
      return count <= limit;
    } catch (err) {
      // fail-OPEN: Redis erişilemezse (donma/OOM/commandTimeout) isteğe İZİN VER — limitleme
      // geçici olarak devre dışı kalır. Gerekçe: hız-sınırı bir KORUMA, kimlik doğrulama DEĞİL;
      // Redis düşünce TÜM trafiği bloklamak erişilebilirliği daha çok bozardı. Güvenlik-kritik
      // kontroller (nonce replay) çağıran tarafta AYRICA fail-CLOSED olur (HmacGuard §4) → çift
      // savunma tutarlı: koruma açılır, güvenlik kapanır. Sessiz kalmasın diye warn'lanır.
      this.logger.warn(`RateLimit Redis hatası — fail-open (izin verildi): ${String(err)}`);
      return true;
    }
  }
}

/**
 * Atomik "artır ve ilk vuruşta süre ver" Lua betiği. KEYS[1]=kova, ARGV[1]=windowSec.
 * Dönen değer güncel sayaçtır; karar (limit karşılaştırması) uygulamada verilir.
 */
const HIT_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return c
`;
