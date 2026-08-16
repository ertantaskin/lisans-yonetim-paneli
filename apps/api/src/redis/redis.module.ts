import { Global, Logger, Module, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS = Symbol('REDIS');

/**
 * Bağlantı-düzeyi hata logu için SESSİZLEŞTİRME penceresi (ms).
 *
 * NEDEN: Redis erişilemezken ioredis sürekli yeniden bağlanmayı dener ve HER denemede bir
 * `error` olayı yayar (saniyede birden fazla). Hepsini loglamak, kesinti sırasında logu
 * kullanılamaz hâle getirir (asıl teşhis satırlarını gömer). Aynı sınıf hata bu pencere
 * boyunca yalnız BİR KEZ yazılır; pencere dolunca yeniden yazılır → arıza sürüyorsa log
 * susmaz, ama sel de olmaz.
 */
const REDIS_ERROR_LOG_WINDOW_MS = 30_000;

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
        const client = new Redis(url, {
          commandTimeout: 2000, // her komut en geç ~2sn'de REJECT eder (sonsuz beklemez)
          enableOfflineQueue: false, // bağlantı kopukken komutu kuyruğa alıp bekletme → anında hata
          maxRetriesPerRequest: 1, // komut-başı yeniden deneme tavanı düşük → hızlı vazgeç
          lazyConnect: false,
        });

        // 'error' DİNLEYİCİSİ ŞART (denetim A6) — iki ayrı sebeple:
        //
        // (1) GÖRÜNÜRLÜK: ioredis dinleyicisi olmayan bağlantı hatalarını `silentEmit` yoluyla
        //     HAM `console.error` ile stderr'e yazar. O satır pino JSON'una GİRMEZ → Sentry
        //     görmez, hiçbir log sorgusuyla eşleşmez. Sonuç: Redis kimlik/TLS/ad çözümleme
        //     arızası pratikte GÖRÜNMEZ olur — oysa bu bağlantı nonce (HmacGuard), rate-limit,
        //     /health ve presence yollarını besler; kesintisi doğrudan mağaza trafiğini etkiler.
        // (2) SÜRECİN HAYATTA KALMASI: dinleyicisi olmayan bir 'error' olayı Node'da
        //     yakalanmamış istisnaya dönüşür. Yani dinleyici, "Redis'siz de ayakta kal"
        //     tasarımının (nonce fail-closed-fast, rate-limit fail-open, /health degraded)
        //     ön koşuludur.
        //
        // BURADA YENİDEN BAĞLANMA DENENMEZ: ioredis'in kendi retry stratejisi devrededir;
        // dinleyicinin tek işi olayı GÖRÜNÜR kılmaktır (sessizleştirme penceresiyle).
        const logger = new Logger('Redis');
        let lastLoggedAt = 0;
        client.on('error', (err: Error) => {
          const now = Date.now();
          if (now - lastLoggedAt < REDIS_ERROR_LOG_WINDOW_MS) return;
          lastLoggedAt = now;
          logger.error(
            `Redis bağlantı hatası (sıcak yol: nonce/rate-limit/health/presence): ${err.message}. ` +
              `Sonraki aynı-sınıf hata en erken ${REDIS_ERROR_LOG_WINDOW_MS / 1000}sn sonra loglanır.`,
          );
        });

        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    // Kapanış Redis'e BAĞLI OLMAMALI: `quit()` bağlantı kopukken/donmuşken reddeder
    // (`enableOfflineQueue: false` + `commandTimeout` ile hızlıca) — sarılmasaydı bu redd
    // shutdown hook'undan yukarı çıkar ve temiz kapanışı yarıda bırakırdı. Soket yine
    // `disconnect()` ile kapatılır.
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
