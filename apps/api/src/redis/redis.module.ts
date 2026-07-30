import { Global, Module, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.getOrThrow<string>('REDIS_URL');
        // Bu bağlantı YALNIZ senkron/sıcak-yol tüketicileri içindir: nonce (HmacGuard §4),
        // rate-limit, /health, presence, admin-lockout, admin-orders. BullMQ AYRI bir bağlantı
        // kurar (queue.module.ts → redisOptionsFromUrl) ve `maxRetriesPerRequest: null`'ı KENDİSİ
        // ayarlar; bu yüzden o kısıt BURAYA UYGULANMAZ ve fail-fast seçebiliriz.
        //
        // NEDEN fail-fast (fault-injection ile KANITLANDI): Redis donunca (OOM/pause) ioredis'in
        // varsayılan davranışı (enableOfflineQueue açık + commandTimeout yok) komutu SONSUZA kadar
        // bekletiyordu → sipariş push'u 12sn ASKIDA kaldı, /health bile yanıt vermedi. Aşağıdaki üç
        // ayar birlikte "askıda kalma"yı bitirir; sağlıklı yolu (komutlar <5ms) etkilemez:
        return new Redis(url, {
          commandTimeout: 2000, // her komut en geç ~2sn'de REJECT eder (sonsuz beklemez)
          enableOfflineQueue: false, // bağlantı kopukken komutu kuyruğa alıp bekletme → anında hata
          maxRetriesPerRequest: 1, // komut-başı yeniden deneme tavanı düşük → hızlı vazgeç
          lazyConnect: false,
        });
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
