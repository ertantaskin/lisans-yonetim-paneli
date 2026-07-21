import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimitService } from '../../src/common/rate-limit.service';

/**
 * ENTEGRASYON — RateLimitService.hit() Lua atomikliği + sınır koşulu (audit MEDIUM).
 *
 * updates/AI/connect-claim suistimal korumasının dayandığı Redis Lua sayacı (INCR + ilk
 * vuruşta EXPIRE) testsizdi (onboarding testi yalnız STUB'lar). Doğrulanan davranışlar:
 *  - Karar sınırı count <= limit (limit=3 iken 3. geçer, 4. reddedilir — off-by-one).
 *  - EXPIRE ilk vuruşta kurulur → anahtar TTL'siz (kalıcı) kalmaz; pencere sıfırlanabilir.
 *  - Sonraki vuruşlar TTL'i UZATMAZ (EXPIRE yalnız c==1).
 *  - İki farklı anahtarın sayaçları bağımsız.
 * Gerçek Redis gerektirir (REDIS_URL). Anahtarlar tag ile izole; afterAll'da silinir.
 */

const tag = randomUUID().slice(0, 8);
let redis: Redis;
let svc: RateLimitService;
const usedKeys: string[] = [];

/** `rl:` önekli gerçek Redis anahtarı (servisin yazdığı) — TTL/temizlik için. */
function rlKey(key: string): string {
  usedKeys.push(`rl:${key}`);
  return key;
}

describe('RateLimitService.hit (Redis Lua sabit-pencere)', () => {
  beforeAll(() => {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL tanımlı değil — rate-limit entegrasyon testi gerçek Redis gerektirir.');
    }
    redis = new Redis(url, { maxRetriesPerRequest: null });
    svc = new RateLimitService(redis as never);
  });

  afterAll(async () => {
    if (usedKeys.length > 0) await redis.del(...usedKeys);
    await redis.quit();
  });

  it('sınır: limit=3 iken ilk 3 vuruş true, 4. false (count <= limit)', async () => {
    const key = rlKey(`it-${tag}-boundary`);
    expect(await svc.hit(key, 3, 60)).toBe(true); // 1
    expect(await svc.hit(key, 3, 60)).toBe(true); // 2
    expect(await svc.hit(key, 3, 60)).toBe(true); // 3 (sınırda geçer)
    expect(await svc.hit(key, 3, 60)).toBe(false); // 4 (aşıldı)
    expect(await svc.hit(key, 3, 60)).toBe(false); // 5
  });

  it('EXPIRE ilk vuruşta kurulur ve sonraki vuruşlar TTL uzatmaz', async () => {
    const key = rlKey(`it-${tag}-ttl`);
    await svc.hit(key, 10, 50);
    const ttl1 = await redis.ttl(`rl:${key}`);
    // TTL kuruldu (kalıcı -1 DEĞİL, yok -2 DEĞİL) ve pencereyi aşmıyor.
    expect(ttl1).toBeGreaterThan(0);
    expect(ttl1).toBeLessThanOrEqual(50);

    // İkinci vuruş farklı (daha büyük) windowSec ile gelse bile TTL UZAMAZ (EXPIRE yalnız c==1).
    await svc.hit(key, 10, 999);
    const ttl2 = await redis.ttl(`rl:${key}`);
    expect(ttl2).toBeLessThanOrEqual(50);
  });

  it('iki farklı anahtarın sayaçları bağımsızdır', async () => {
    const a = rlKey(`it-${tag}-a`);
    const b = rlKey(`it-${tag}-b`);
    expect(await svc.hit(a, 1, 60)).toBe(true); // a: 1
    expect(await svc.hit(a, 1, 60)).toBe(false); // a: 2 (aşıldı)
    expect(await svc.hit(b, 1, 60)).toBe(true); // b: 1 (a'dan bağımsız → hâlâ true)
  });
});
