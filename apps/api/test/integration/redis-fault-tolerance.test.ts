import { randomUUID } from 'node:crypto';
import {
  HttpException,
  ServiceUnavailableException,
  type ExecutionContext,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RateLimitService } from '../../src/common/rate-limit.service';
import { HmacGuard } from '../../src/auth/hmac.guard';
import type { SitesService } from '../../src/sites/sites.service';
import type { Site } from '../../src/db/schema';
import { signHmac } from './_helpers';

/**
 * BİRİM (gerçek Redis/PG GEREKTİRMEZ — fake'lerle) — Redis donması/OOM karşısında dayanıklılık.
 *
 * Fault-injection ile kanıtlanan sorun: Redis donunca komutlar sonsuza kadar bekliyordu →
 * sipariş push'u 12sn askıda, /health bile yanıtsız. Bu dosya iki dayanıklılık kararını sabitler:
 *
 *  - RateLimitService.hit → fail-OPEN: Redis eval hatası verirse İZİN VER (hız-sınırı koruma,
 *    kimlik doğrulama değil; Redis düşünce tüm trafiği bloklamak erişilebilirliği daha çok bozar).
 *  - HmacGuard nonce SET → fail-CLOSED-FAST: Redis hatası verirse hızlıca 503 (nonce güvenlik
 *    kontrolü; replay penceresi doğrulanamıyorsa reddet, ASKIDA KALMA). WP 503'ü retry eder.
 *  - HmacGuard IP hız-sınırı: DB findForAuth'tan ÖNCE aşılırsa 429 (+Retry-After) → geçersiz-imza
 *    seli DB havuzunu tüketemez.
 *  - Çift savunma: rate-limit fail-open (izin) + nonce fail-closed (red) BİRLİKTE tutarlı.
 */

const PATH = '/v1/orders';
const METHOD = 'GET';

/** Guard `getRequest()`/`getResponse()` okur; response `header()` (Retry-After) için gerekir. */
function ctxFor(req: unknown, res: unknown = { header: () => undefined }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

/** Geçerli imzalı, fastify-benzeri bir istek (guard'ın nonce/imza adımlarına ulaşacak biçimde). */
function signedReq(apiKey: string, secret: string, ip = '203.0.113.7') {
  const signed = signHmac({ method: METHOD, path: PATH, apiKey, secret });
  return { headers: signed.headers, method: METHOD, url: PATH, rawBody: signed.rawBody, ip };
}

/** findForAuth'u istenen sonuçla taklit eden minimal SitesService. */
function fakeSites(secret: string): { svc: SitesService; findForAuth: ReturnType<typeof vi.fn> } {
  const site = { id: `site-${randomUUID()}`, pluginVersion: null } as unknown as Site;
  const findForAuth = vi.fn(async () => ({ site, hmacSecrets: [secret] }));
  return { svc: { findForAuth } as unknown as SitesService, findForAuth };
}

describe('RateLimitService.hit — Redis hatası → fail-OPEN', () => {
  it('eval reject ederse izin verir (true) ve sessiz kalmaz', async () => {
    const throwingRedis = {
      eval: vi.fn(async () => {
        throw new Error('redis down (simüle)');
      }),
    };
    const svc = new RateLimitService(throwingRedis as never);
    // Limit 1 iken normalde 2. çağrı false olurdu; Redis hatası → hepsi true (koruma devre dışı).
    await expect(svc.hit('unit:fail-open', 1, 60)).resolves.toBe(true);
    await expect(svc.hit('unit:fail-open', 1, 60)).resolves.toBe(true);
    expect(throwingRedis.eval).toHaveBeenCalled();
  });

  it('eval sayı döndürürse normal karar (count <= limit) korunur', async () => {
    let n = 0;
    const okRedis = { eval: vi.fn(async () => ++n) };
    const svc = new RateLimitService(okRedis as never);
    expect(await svc.hit('unit:normal', 2, 60)).toBe(true); // 1
    expect(await svc.hit('unit:normal', 2, 60)).toBe(true); // 2 (sınırda)
    expect(await svc.hit('unit:normal', 2, 60)).toBe(false); // 3 (aşıldı)
  });
});

describe('HmacGuard — Redis-DOWN nonce fail-CLOSED-FAST', () => {
  it('nonce SET reject ederse hızlıca 503 (ServiceUnavailable) atar', async () => {
    const secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const apiKey = `ak-${randomUUID()}`;
    const { svc } = fakeSites(secret);
    const nonceRedis = {
      set: vi.fn(async () => {
        throw new Error('redis down (simüle)');
      }),
    };
    // 2-arg guard → IP hız-sınırı adımı atlanır; yalnız nonce fail-closed'ı izole eder.
    const guard = new HmacGuard(svc, nonceRedis as never);
    const req = signedReq(apiKey, secret);

    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(nonceRedis.set).toHaveBeenCalledOnce();
  });
});

describe('HmacGuard — IP hız-sınırı (findForAuth ÖNCESİ)', () => {
  it('IP limiti aşılırsa 429 atar ve findForAuth ÇAĞRILMAZ (DB korunur)', async () => {
    const secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const apiKey = `ak-${randomUUID()}`;
    const { svc, findForAuth } = fakeSites(secret);
    const nonceRedis = { set: vi.fn(async () => 'OK') };
    const denyingRateLimit = { hit: vi.fn(async () => false) };
    const config = { get: vi.fn(() => undefined) };
    const guard = new HmacGuard(
      svc,
      nonceRedis as never,
      denyingRateLimit as never,
      config as never,
    );
    const header = vi.fn();
    const req = signedReq(apiKey, secret);

    let caught: unknown;
    try {
      await guard.canActivate(ctxFor(req, { header }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(429);
    // Kritik: hız-sınırı DB lookup'ından ÖNCE reddetti (geçersiz-imza seli DB'yi harcayamaz).
    expect(findForAuth).not.toHaveBeenCalled();
    expect(header).toHaveBeenCalledWith('retry-after', expect.any(String));
  });

  it('env HMAC_IP_RATE_LIMIT geçersizken cömert varsayılan (600) ile hit çağrılır', async () => {
    const secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const apiKey = `ak-${randomUUID()}`;
    const { svc } = fakeSites(secret);
    const nonceRedis = { set: vi.fn(async () => 'OK') };
    const allowingRateLimit = { hit: vi.fn(async () => true) };
    const config = { get: vi.fn(() => undefined) }; // env yok → 600
    const guard = new HmacGuard(
      svc,
      nonceRedis as never,
      allowingRateLimit as never,
      config as never,
    );
    const req = signedReq(apiKey, secret);

    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(allowingRateLimit.hit).toHaveBeenCalledWith(
      expect.stringMatching(/^hmac:ip:/),
      600,
      60,
    );
  });
});

describe('HmacGuard + RateLimitService — çift savunma (fail-open + fail-closed)', () => {
  it('Redis hem eval hem set için reject: rate-limit izin verir ama nonce 503 ile kapatır', async () => {
    const secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const apiKey = `ak-${randomUUID()}`;
    const { svc } = fakeSites(secret);
    // Tek fake bağlantı: hem RateLimitService.eval hem guard nonce.set için reject eder.
    const downRedis = {
      eval: vi.fn(async () => {
        throw new Error('redis down (simüle)');
      }),
      set: vi.fn(async () => {
        throw new Error('redis down (simüle)');
      }),
    };
    const rateLimit = new RateLimitService(downRedis as never);
    const config = { get: vi.fn(() => undefined) };
    const guard = new HmacGuard(svc, downRedis as never, rateLimit, config as never);
    const req = signedReq(apiKey, secret);

    // rate-limit fail-open → geçer; imza doğru → nonce'a ulaşır; nonce fail-closed → 503.
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(downRedis.eval).toHaveBeenCalled(); // rate-limit denendi (fail-open)
    expect(downRedis.set).toHaveBeenCalled(); // nonce denendi (fail-closed)
  });
});
