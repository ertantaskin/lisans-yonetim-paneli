import { randomUUID } from 'node:crypto';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HMAC_KEY_ROTATION_GRACE_SEC, HMAC_TIMESTAMP_TOLERANCE_SEC } from '@jetlisans/shared';
import { HmacGuard } from '../../src/auth/hmac.guard';
import { SitesService } from '../../src/sites/sites.service';
import { CryptoService } from '../../src/crypto/crypto.service';
import * as schema from '../../src/db/schema';
import type { Database } from '../../src/db/db.module';
import {
  cleanupByTag,
  createSite,
  makeCrypto,
  makeDb,
  signHmac,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — HmacGuard (§4), gerçek PostgreSQL (findForAuth) + IN-MEMORY sahte Redis (nonce).
 *
 * Nest ayağa KALDIRILMAZ: guard elle new'lenir (gerçek SitesService + gerçek CryptoService +
 * sahte Redis). ExecutionContext, fastify-benzeri minimal bir request (headers/method/url/rawBody)
 * döndürür. İmza `signHmac` (_helpers) ile guard'ın beklediği biçimde birebir kurulur.
 *
 * NEDEN sahte Redis: nonce tekilliği yalnız `set(key,'1','EX',ttl,'NX')` semantiğine dayanır
 * (ilk sefer 'OK', sonra null). Bu tek çağrı deterministik bir Map ile birebir taklit edilebilir;
 * gerçek Redis bağımlılığı olmadan replay penceresi kesin test edilir (görev: "uygun fake").
 *
 * Her assert kendi tag'iyle seed edip afterAll'da yalnız kendi eklediklerini siler.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let sites: SitesService;

/** `set(key,'1','EX',ttl,'NX')` semantiği: aynı anahtar ikinci kez → null (replay reddi). */
function makeFakeRedis(): { redis: any; store: Map<string, string> } {
  const store = new Map<string, string>();
  const redis = {
    async set(key: string, value: string, _ex: string, _ttl: number, mode?: string) {
      if (mode === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
  };
  return { redis, store };
}

/** Guard yalnız context.switchToHttp().getRequest() → req okur (headers/method/url/rawBody). */
function ctxFor(req: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/**
 * İmzalı bir isteği guard'a taşıyacak fastify-benzeri request üretir. `signHmac` başlıkları +
 * rawBody'yi verir; method/url imza payload'ıyla BİREBİR aynı olmalı (canonicalizePath uygular).
 */
function reqFor(opts: {
  method: string;
  path: string;
  apiKey: string;
  secret: string;
  timestamp?: number;
  nonce?: string;
  dropSignature?: boolean;
}): { headers: Record<string, string>; method: string; url: string; rawBody: Buffer } {
  const signed = signHmac({
    method: opts.method,
    path: opts.path,
    apiKey: opts.apiKey,
    secret: opts.secret,
    timestamp: opts.timestamp,
    nonce: opts.nonce,
  });
  const headers = { ...signed.headers };
  if (opts.dropSignature) delete headers['x-signature'];
  return { headers, method: opts.method, url: opts.path, rawBody: signed.rawBody };
}

describe('HmacGuard (HMAC imza + nonce replay + rotasyon grace)', () => {
  beforeAll(async () => {
    const h = makeDb();
    db = h.db;
    end = h.end;
    crypto = makeCrypto();
    sites = new SitesService(db as unknown as Database, crypto);
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('geçerli imza → geçer (true) ve req.site iliştirir', async () => {
    const site = await createSite(db, crypto, { tag });
    const { redis } = makeFakeRedis();
    const guard = new HmacGuard(sites, redis);
    const req = reqFor({ method: 'GET', path: '/v1/orders', apiKey: site.apiKey, secret: site.hmacSecret });

    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect((req as { site?: { id: string } }).site?.id).toBe(site.id);
  });

  it('eksik başlık (imza yok) → 401 (Eksik imza başlıkları)', async () => {
    const site = await createSite(db, crypto, { tag });
    const { redis } = makeFakeRedis();
    const guard = new HmacGuard(sites, redis);
    const req = reqFor({
      method: 'GET',
      path: '/v1/orders',
      apiKey: site.apiKey,
      secret: site.hmacSecret,
      dropSignature: true,
    });

    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('yanlış imza (uyumsuz secret ile imzalanmış) → 401 (Geçersiz imza)', async () => {
    const site = await createSite(db, crypto, { tag });
    const { redis } = makeFakeRedis();
    const guard = new HmacGuard(sites, redis);
    // apiKey doğru → findForAuth siteyi bulur; ama imza alakasız bir secret'la kuruldu → hiçbiri eşleşmez.
    const wrongSecret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const req = reqFor({ method: 'GET', path: '/v1/orders', apiKey: site.apiKey, secret: wrongSecret });

    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('zaman penceresi dışında (timestamp çok eski) → 401', async () => {
    const site = await createSite(db, crypto, { tag });
    const { redis } = makeFakeRedis();
    const guard = new HmacGuard(sites, redis);
    // İmza kendi (eski) timestamp'iyle geçerli kurulur ama pencere kontrolü (adım 1) önce reddeder.
    const stale = Math.floor(Date.now() / 1000) - (HMAC_TIMESTAMP_TOLERANCE_SEC + 100);
    const req = reqFor({
      method: 'GET',
      path: '/v1/orders',
      apiKey: site.apiKey,
      secret: site.hmacSecret,
      timestamp: stale,
    });

    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('nonce replay (aynı istek iki kez) → ilki geçer, ikincisi 401 reddedilir', async () => {
    const site = await createSite(db, crypto, { tag });
    const { redis } = makeFakeRedis();
    const guard = new HmacGuard(sites, redis);
    const nonce = randomUUID();
    // AYNI nonce + AYNI imza iki kez: ilk canActivate nonce'u harcar → ikinci NX başarısız.
    const first = reqFor({ method: 'GET', path: '/v1/orders', apiKey: site.apiKey, secret: site.hmacSecret, nonce });
    const second = reqFor({ method: 'GET', path: '/v1/orders', apiKey: site.apiKey, secret: site.hmacSecret, nonce });

    await expect(guard.canActivate(ctxFor(first))).resolves.toBe(true);
    await expect(guard.canActivate(ctxFor(second))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rotasyon grace: secret rotasyonundan sonra ESKİ + YENİ secret imzası da kabul edilir', async () => {
    const site = await createSite(db, crypto, { tag });
    const { redis } = makeFakeRedis();
    const guard = new HmacGuard(sites, redis);

    // Rotasyon: mevcut secret prev'e taşınır, yeni secret döner (24s ikisi de geçerli).
    const { hmacSecret: newSecret } = await sites.rotateSecret(site.id);

    // ESKİ secret (artık prev) → grace penceresinde imza kabul edilir.
    const withOld = reqFor({ method: 'GET', path: '/v1/orders', apiKey: site.apiKey, secret: site.hmacSecret });
    await expect(guard.canActivate(ctxFor(withOld))).resolves.toBe(true);

    // YENİ secret → her zaman kabul.
    const withNew = reqFor({ method: 'GET', path: '/v1/orders', apiKey: site.apiKey, secret: newSecret });
    await expect(guard.canActivate(ctxFor(withNew))).resolves.toBe(true);
  });

  it('rotasyon grace penceresi DIŞINDA: eski secret reddedilir, yeni secret kabul kalır', async () => {
    const site = await createSite(db, crypto, { tag });
    const { redis } = makeFakeRedis();
    const guard = new HmacGuard(sites, redis);

    const { hmacSecret: newSecret } = await sites.rotateSecret(site.id);
    // Rotasyon zamanını grace penceresinin ÖTESİNE it → eski secret artık kabul listesinde değil.
    await db
      .update(schema.sites)
      .set({ hmacSecretRotatedAt: new Date(Date.now() - (HMAC_KEY_ROTATION_GRACE_SEC + 3600) * 1000) })
      .where(eq(schema.sites.id, site.id));

    const withOld = reqFor({ method: 'GET', path: '/v1/orders', apiKey: site.apiKey, secret: site.hmacSecret });
    await expect(guard.canActivate(ctxFor(withOld))).rejects.toBeInstanceOf(UnauthorizedException);

    // Güncel secret hâlâ geçerli.
    const withNew = reqFor({ method: 'GET', path: '/v1/orders', apiKey: site.apiKey, secret: newSecret });
    await expect(guard.canActivate(ctxFor(withNew))).resolves.toBe(true);
  });
});
