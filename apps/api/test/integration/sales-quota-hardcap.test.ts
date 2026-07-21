import { randomUUID } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateOrderRequest } from '@jetlisans/shared';
import type { Site } from '../../src/db/schema';
import { OrdersService } from '../../src/orders/orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { ProductsService } from '../../src/products/products.service';
import { SalesQuotaExceededException } from '../../src/orders/sales-quota.exception';
import type { CryptoService } from '../../src/crypto/crypto.service';
import type { CreateOrderOutcome } from '../../src/orders/orders.service';
import {
  cleanupByTag,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  type CreatedProduct,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — #20 sert günlük satış kotası (salesDailyQuota) TOCTOU / advisory-lock sert tavan.
 *
 * createOrder içinde, site başına pg_advisory_xact_lock ALTINDA bugünkü sipariş sayısı kotaya karşı
 * kontrol edilir; kota dolunca SalesQuotaExceededException (429, todayCount/limit/retryAfterSec taşır)
 * fırlatılır ve transaction ROLLBACK → sipariş satırı OLUŞMAZ. İdempotent retry (aynı remoteOrderId)
 * kota kontrolünden ÖNCEki idempotency lookup'ından döner → kotada/üstünde bile REDDEDİLMEZ (mevcut
 * sonucu döndürür). Bu dosya sayım-tabanlı reddi + idempotent-retry-reddedilmez güvencesini kilitler.
 *
 * (Gerçek eşzamanlılık/yarış test edilmez — advisory-lock onu deterministik kılar; burada davranışsal
 * sayaç + idempotent-retry doğrulanır.)
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let products: ProductsService;
let orders: OrdersService;

let siteObj: Site;
let remoteProductId: string;
let product: CreatedProduct;

// order #1 idempotent re-push için saklanır.
let order1Dto: CreateOrderRequest;
let order1Outcome: CreateOrderOutcome;

const QUOTA = 2;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;
const securityFake = { recordQuotaExceeded: async () => false } as never;

function makeDto(): CreateOrderRequest {
  return {
    remoteOrderId: `ord-${randomUUID().slice(0, 8)}`,
    customerEmail: `${tag}@example.test`,
    lines: [{ remoteLineId: 'line-1', remoteProductId, qty: 1 }],
  };
}

describe('#20 sert satış kotası (salesDailyQuota) sert tavan + idempotent-retry', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    products = new ProductsService(db as never);
    const fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    const admin = new AdminOrdersService(db as never, redisFake, crypto, mailFake, fulfillment);
    orders = new OrdersService(
      db as never,
      products,
      crypto,
      mailFake,
      webhookFake,
      fulfillment,
      admin,
      securityFake,
    );

    const s = await createSite(db, crypto, { tag, salesDailyQuota: QUOTA });
    product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'partial-auto',
    });
    remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
    await products.createMapping({ siteId: s.id, productId: product.id, remoteProductId });
    // Kota=2 iki siparişi karşılayacak stok (3. zaten kotada reddedilir).
    await insertLicenseItems(db, crypto, { productId: product.id, count: 4, tag });

    // createOrder kotayı PASING site nesnesinden okur → salesDailyQuota=QUOTA burada set edilir.
    siteObj = {
      id: s.id,
      domain: s.domain,
      salesDailyQuota: QUOTA,
      dynamicQuotaEnabled: false,
      reviewMultiplier: 3,
    } as unknown as Site;
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('ilk 2 farklı sipariş kotayı doldurur (başarılı)', async () => {
    order1Dto = makeDto();
    order1Outcome = await orders.createOrder(siteObj, order1Dto);
    expect(order1Outcome.httpStatus).toBe(201);
    expect(order1Outcome.body.status).toBe('fulfilled');

    const second = await orders.createOrder(siteObj, makeDto());
    expect(second.httpStatus).toBe(201);
    expect(second.body.status).toBe('fulfilled');
  });

  it('3. farklı sipariş → SalesQuotaExceededException (429, todayCount/limit/retryAfterSec)', async () => {
    let caught: unknown;
    try {
      await orders.createOrder(siteObj, makeDto());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SalesQuotaExceededException);
    const err = caught as SalesQuotaExceededException;
    expect(err.getStatus()).toBe(429);
    expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(err.limit).toBe(QUOTA);
    expect(err.todayCount).toBe(QUOTA); // bugün 2 sipariş ≥ kota 2
    expect(err.retryAfterSec).toBeGreaterThan(0);
  });

  it('idempotent re-push (aynı remoteOrderId) kotada BİLE reddedilmez → mevcut sonucu döndürür', async () => {
    // sipariş #1'i aynı dto ile tekrar push et — idempotency lookup kota kontrolünden ÖNCE döner.
    const replay = await orders.createOrder(siteObj, order1Dto);
    expect(replay.body.orderId).toBe(order1Outcome.body.orderId);
    expect(replay.body.status).toBe(order1Outcome.body.status);
    expect(replay.httpStatus).toBe(order1Outcome.httpStatus);
  });
});
