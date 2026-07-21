import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

/** Presence kaydının canlı sayıldığı süre (sn). Heartbeat bu aralıktan sık yenilenmeli. */
const PRESENCE_TTL_SEC = 30;

/**
 * Operatör presence / çakışma uyarısı (§14). Aynı kaynağı (ör. aynı sipariş sayfası)
 * eş zamanlı görüntüleyen operatörleri Redis'te tutar — iki admin aynı kaydı aynı anda
 * işlerse çakışmayı önlemek için birbirini görsün.
 *
 * Depolama: kaynak başına sorted set `presence:{resource}`; üye = actor, skor = son
 * heartbeat zamanı (ms). Skorla budama sayesinde ayrılan/çöken operatörler otomatik
 * düşer; anahtar TTL'i de tümüyle boşalınca temizler. Kalıcı veri değil — best-effort.
 */
@Injectable()
export class PresenceService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(resource: string): string {
    return `presence:${resource}`;
  }

  /**
   * `actor`'ın `resource` üzerindeki varlığını tazeler (skor = şimdi) ve süresi
   * geçmiş üyeleri budar. Anahtara 2×TTL ömür koyar → tümüyle boşalırsa Redis temizler.
   */
  async heartbeat(resource: string, actor: string): Promise<void> {
    const key = this.key(resource);
    const now = Date.now();
    await this.redis.zadd(key, now, actor);
    await this.redis.zremrangebyscore(key, 0, now - PRESENCE_TTL_SEC * 1000);
    await this.redis.expire(key, PRESENCE_TTL_SEC * 2);
  }

  /**
   * `resource` üzerinde şu an canlı sayılan (son TTL içinde heartbeat atmış) benzersiz
   * operatör listesi. Sorted set üyeleri doğası gereği tekildir; önce eskiler budanır.
   */
  async list(resource: string): Promise<string[]> {
    const key = this.key(resource);
    const now = Date.now();
    await this.redis.zremrangebyscore(key, 0, now - PRESENCE_TTL_SEC * 1000);
    return this.redis.zrangebyscore(key, now - PRESENCE_TTL_SEC * 1000, '+inf');
  }
}
