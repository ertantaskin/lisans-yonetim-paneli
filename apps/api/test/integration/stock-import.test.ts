import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { BadRequestException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import type { Site } from '../../src/db/schema';
import { StockService } from '../../src/stock/stock.service';
import { OrdersService } from '../../src/orders/orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { ProductsService } from '../../src/products/products.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createOrderWithLine,
  createProduct,
  createSite,
  makeCrypto,
  makeDb,
  type CreatedSite,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — StockService.import (§12 stok import + envelope AAD round-trip).
 *
 * Doğrulanan davranışlar:
 *  (a) geçerli key import → şifrelenip 'available' girer; sipariş satırına atanınca getDeliveries
 *      licenseItem AAD ile ÇÖZER → müşteriye doğru plaintext döner (round-trip decrypt).
 *  (b) bozuk keyFormat regex / eksik account alanı → rejected raporuna düşer (imported azalır,
 *      SESSİZ yutma yok).
 *  (c) usageMode='multi' ürün maxUses eksik/1 → BadRequest (MAK yanlış-yapılandırması erken yakalanır).
 *  (d) aynı payloadHash iki kez → ikinci mükerrer sayılır (kalıcı olmaz, UNIQUE dedupe).
 *  (e) dryRun (validateOnly) → HİÇBİR satır kalıcı olmaz (yalnız doğrulama + tahmin).
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let products: ProductsService;
let stock: StockService;
let orders: OrdersService;
let site: CreatedSite;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;
const securityFake = {
  recordQuotaExceeded: async () => false,
  recordQuotaHeld: async () => false,
} as never;

/** Bu ürün için DB'de kaç license_item var (kalıcılık kontrolü). */
async function itemCount(productId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.licenseItems.id })
    .from(schema.licenseItems)
    .where(eq(schema.licenseItems.productId, productId));
  return rows.length;
}

describe('StockService.import (envelope AAD + doğrulama/dedupe/dryRun)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    products = new ProductsService(db as never);
    const fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    const admin = new AdminOrdersService(db as never, redisFake, crypto, mailFake, fulfillment);
    stock = new StockService(db as never, crypto, products, fulfillment);
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
    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('(a) geçerli key import → atanınca getDeliveries AAD ile doğru plaintext ÇÖZER', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'partial-auto',
    });
    // Bekleyen sipariş: import'un autoCompleteProduct'ı bunu doldurmalı.
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
      status: 'pending',
    });

    const PLAINTEXT = `WIN-${tag}-${randomUUID().slice(0, 12)}`;
    const res = await stock.import(product.id, [{ payload: PLAINTEXT }]);
    expect(res.imported).toBe(1);
    expect(res.rejected).toBe(0);
    expect(res.duplicates).toBe(0);
    // Bekleyen satır import'la tamamlandı.
    expect(res.autoCompleted).toBeGreaterThanOrEqual(1);

    // getDeliveries: AAD (license_item:<id>) ile çözülmüş plaintext müşteriye DOĞRU döner.
    const deliv = await orders.getDeliveries(
      { id: site.id, domain: site.domain } as unknown as Site,
      order.orderId,
    );
    expect(deliv.deliveries).toHaveLength(1);
    expect(deliv.deliveries[0]!.payload).toBe(PLAINTEXT);
  });

  it('(b1) bozuk keyFormat regex → uyumsuz satır rejected raporuna düşer (imported azalır)', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
    });
    // keyFormat helper'da yok → doğrudan ürün satırına yaz (^KEY-<rakam>$).
    await db
      .update(schema.products)
      .set({ keyFormat: '^KEY-\\d+$' })
      .where(eq(schema.products.id, product.id));

    const res = await stock.import(product.id, [
      { payload: `KEY-${Math.floor(Math.random() * 1e6)}` }, // uyar
      { payload: 'gecersiz-format' }, // uymaz → rejected
    ]);
    expect(res.requested).toBe(2);
    expect(res.imported).toBe(1);
    expect(res.rejected).toBe(1);
    expect(res.rejections).toHaveLength(1);
    expect(res.rejections[0]!.index).toBe(1); // ikinci satır reddedildi
  });

  it('(b2) account eksik zorunlu alan → o satır rejected (geçerli satır girer)', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'account',
      usageMode: 'single',
      payloadSchema: [
        { key: 'username', label: 'Kullanıcı adı', secret: false, required: true },
        { key: 'password', label: 'Parola', secret: true, required: true },
      ],
    });

    const res = await stock.import(product.id, [
      { payload: { username: `u-${tag}`, password: `p-${tag}` } }, // tam → girer
      { payload: { username: `only-${tag}` } }, // password eksik → rejected
    ]);
    expect(res.requested).toBe(2);
    expect(res.imported).toBe(1);
    expect(res.rejected).toBe(1);
    expect(res.rejections[0]!.index).toBe(1);
    // Yalnız geçerli satır kalıcı oldu.
    expect(await itemCount(product.id)).toBe(1);
  });

  it('(c) multi ürün maxUses eksik → BadRequestException (import reddedilir)', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'multi', // maxUses OMIT → null; multi guard tetiklenir
    });
    await expect(stock.import(product.id, [{ payload: `MAK-${tag}` }])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Hiçbir şey girmedi.
    expect(await itemCount(product.id)).toBe(0);
  });

  it('(d) aynı payloadHash iki kez → ikinci mükerrer (kalıcı olmaz)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const DUP = `DUP-${tag}-${randomUUID().slice(0, 12)}`;

    const first = await stock.import(product.id, [{ payload: DUP }]);
    expect(first.imported).toBe(1);
    expect(first.duplicates).toBe(0);

    const second = await stock.import(product.id, [{ payload: DUP }]);
    expect(second.imported).toBe(0);
    expect(second.duplicates).toBe(1);

    // DB'de yalnız 1 kopya (UNIQUE payload_hash dedupe).
    expect(await itemCount(product.id)).toBe(1);
  });

  it('(e) dryRun=true → doğrulama yapılır ama HİÇBİR satır kalıcı olmaz', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });

    const res = await stock.import(
      product.id,
      [{ payload: `DRY-${tag}-1` }, { payload: `DRY-${tag}-2` }],
      undefined,
      true, // dryRun
    );
    expect(res.dryRun).toBe(true);
    expect(res.imported).toBe(0);
    expect(res.wouldImport).toBe(2);

    // Kuru çalıştırma → DB'de hiç kayıt yok.
    expect(await itemCount(product.id)).toBe(0);
    // available count da 0.
    const avail = await db
      .select({ id: schema.licenseItems.id })
      .from(schema.licenseItems)
      .where(
        and(eq(schema.licenseItems.productId, product.id), eq(schema.licenseItems.status, 'available')),
      );
    expect(avail).toHaveLength(0);
  });
});
