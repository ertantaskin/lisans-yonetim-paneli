import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { RedisOptions } from 'ioredis';

/**
 * REDIS_URL → ioredis bağlantı seçenekleri (TEK dönüştürücü).
 *
 * NEDEN VAR (regresyon dersi): burada eskiden yalnız `host` + `port` okunuyordu; RedisModule ise
 * URL'in TAMAMINI ioredis'e veriyordu (`new Redis(url)`). İki yol AYRIŞTIĞI an sistem sinsi
 * biçimde bozulur: operatör Redis'e parola koyar ya da yönetilen/TLS bir Redis'e (rediss://,
 * kullanıcı adı, ayrı db) geçerse
 *   - nonce/rate-limit (RedisModule) ÇALIŞMAYA devam eder ve `/v1/health` "redis ok" der,
 *   - ama BullMQ NOAUTH/TLS hatası alır → teslimat maili, geri-kanal webhook ve TÜM sweep'ler
 *     (expiry/reconcile/low-stock/security/daily-digest) HİÇ çalışmaz,
 *   - enqueue hataları best-effort try/catch'lerle yutulduğu için sipariş 201 döner:
 *     panel SAĞLIKLI görünür, müşteri mailini hiç almaz.
 * Bu yüzden BullMQ bağlantısı da URL'in TAMAMINDAN kurulur (kullanıcı/parola/db/TLS dahil).
 *
 * DEĞİŞTİRİRKEN: RedisModule (`new Redis(REDIS_URL)`) ile aynı URL'i aynı şekilde onurlandırmalı;
 * yeni bir URL alanı desteklenecekse İKİ yol birlikte gözden geçirilmeli.
 *
 * NOT: `maxRetriesPerRequest` BİLEREK ayarlanmaz — BullMQ bloklayan (worker) bağlantılarda bu
 * değeri kendisi `null` yapar; burada elle set etmek uyarı/hata üretir.
 */
export function redisOptionsFromUrl(rawUrl: string): RedisOptions {
  const url = new URL(rawUrl);
  // redis:// | rediss:// (TLS). Yönetilen sağlayıcılar (Upstash, ElastiCache, Redis Cloud…) rediss kullanır.
  const tls = url.protocol === 'rediss:';
  // Yol kısmı veritabanı indeksidir (ör. redis://host:6379/2). Boş/'/' ise varsayılan (0).
  const dbRaw = url.pathname.replace(/^\//, '');
  const db = dbRaw.length > 0 ? Number(dbRaw) : undefined;
  // Kimlik bilgileri URL'de yüzde-kodlu olabilir (parolada '@', ':' vb.) → decode ŞART.
  const username = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;

  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(db !== undefined && Number.isFinite(db) ? { db } : {}),
    // SNI için servername: TLS sonlandırıcı doğru sertifikayı seçebilsin.
    ...(tls ? { tls: { servername: url.hostname } } : {}),
  };
}

/**
 * BullMQ kök bağlantısı — tek yerde (§1). Mail ve webhook kuyrukları bunu paylaşır.
 * Global: feature modülleri BullModule.registerQueue ile kuyruk tanımlar.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Tam URL'den kurulur (parola/kullanıcı/db/TLS) — bkz. redisOptionsFromUrl gerekçesi.
        connection: redisOptionsFromUrl(config.getOrThrow<string>('REDIS_URL')),
        // Kuyruk hijyeni ağı (§16): başarısız işler için genel tavan. Her üretici zaten
        // kendi removeOnFail'ini geçer (bunu ezer); bir üretici unutursa Redis'te sınırsız
        // başarısız-iş birikimine karşı belt-and-suspenders varsayılan.
        defaultJobOptions: { removeOnFail: 5000 },
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
