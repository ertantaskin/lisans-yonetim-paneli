import { randomUUID } from 'node:crypto';
import { HttpException, HttpStatus, type ExecutionContext } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { SalesQuotaGuard } from '../../src/orders/sales-quota.guard';
import type { SecurityService } from '../../src/security/security.service';
import type { Database } from '../../src/db/db.module';
import type { Site } from '../../src/db/schema';
import {
  cleanupByTag,
  createOrderWithLine,
  createProduct,
  createSite,
  makeCrypto,
  makeDb,
  type Db,
} from './_helpers';

/**
 * SalesQuotaGuard entegrasyon testi (§5).
 *
 * Guard, HmacGuard'dan SONRA çalışır: req.site iliştirilmiş kabul edilir. Bugünkü
 * sipariş sayısını gerçek DB'den sayar (created_at >= date_trunc('day', now())) ve
 * site.salesDailyQuota dolmuşsa 429 (TOO_MANY_REQUESTS) fırlatır.
 *
 * Nest ayağa kaldırılmaz: guard elle new'lenir (db bağımlılığı gerçek db ile), sahte
 * ExecutionContext getRequest() → { site } döndürür. Her assert kendi tag'iyle seed
 * edip afterAll'da yalnız kendi eklediklerini siler.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let guard: SalesQuotaGuard;
let productId: string;
let siteId: string;

/**
 * Guard, getRequest().site okur; 429 yolunda getResponse().header(...) ile Retry-After yazar.
 * Minimal fastify-benzeri sahte: getResponse header no-op (başlık davranışı burada test edilmez).
 */
function ctxWithSite(site: Partial<Site> | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ site }),
      getResponse: () => ({ header: () => undefined }),
    }),
  } as unknown as ExecutionContext;
}

/** recordQuotaExceeded yalnız gözlemleme (best-effort) — testte no-op stub yeter. */
const fakeSecurity = {
  recordQuotaExceeded: async () => true,
} as unknown as SecurityService;

/** req.site olarak geçilecek minimal site nesnesi (guard yalnız id + salesDailyQuota okur). */
function siteObj(salesDailyQuota: number | null): Partial<Site> {
  return { id: siteId, salesDailyQuota } as Partial<Site>;
}

describe('SalesQuotaGuard (günlük satış kotası)', () => {
  beforeAll(async () => {
    const h = makeDb();
    db = h.db;
    end = h.end;
    const crypto = makeCrypto();
    guard = new SalesQuotaGuard(db as unknown as Database, fakeSecurity);

    // Sipariş FK'leri için gerçek site + ürün (kotayı req.site'ta ayarlıyoruz, DB'de değil).
    const site = await createSite(db, crypto, { tag });
    siteId = site.id;
    const product = await createProduct(db, { tag });
    productId = product.id;
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('kota null (limitsiz) → bugünkü sipariş olsa bile geçer', async () => {
    await createOrderWithLine(db, { siteId, productId, qty: 1, tag });
    await expect(guard.canActivate(ctxWithSite(siteObj(null)))).resolves.toBe(true);
  });

  it('req.site yok → guard geçer (HmacGuard zaten reddederdi)', async () => {
    await expect(guard.canActivate(ctxWithSite(undefined))).resolves.toBe(true);
  });

  it('kota dolu (quota=1, bugün 1 sipariş) → 429 TooManyRequests fırlatır', async () => {
    // beforeAll'daki + null testindeki siparişler dâhil bugün >=1 sipariş var.
    await createOrderWithLine(db, { siteId, productId, qty: 1, tag });

    await expect(guard.canActivate(ctxWithSite(siteObj(1)))).rejects.toBeInstanceOf(HttpException);
    try {
      await guard.canActivate(ctxWithSite(siteObj(1)));
      throw new Error('429 beklenirken exception fırlatılmadı');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    }
  });

  it('kota altında (quota bugünkü sayının üstünde) → geçer (true)', async () => {
    // Bugünkü sipariş sayısını oku (guard ile birebir aynı koşul); kotayı bir üstüne
    // ayarla → sınırın altında kalır, guard geçmeli.
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.siteId, siteId),
          gte(schema.orders.createdAt, sql`date_trunc('day', now())`),
        ),
      );
    const today = row?.count ?? 0;
    await expect(guard.canActivate(ctxWithSite(siteObj(today + 1)))).resolves.toBe(true);
  });
});
