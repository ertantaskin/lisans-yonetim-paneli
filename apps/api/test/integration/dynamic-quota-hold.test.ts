import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { BadRequestException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateOrderRequest } from '@jetlisans/shared';
import * as schema from '../../src/db/schema';
import type { Site } from '../../src/db/schema';
import { OrdersService } from '../../src/orders/orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { ProductsService } from '../../src/products/products.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  tagPrefix,
  type CreatedProduct,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — §8 dinamik kota → held_for_review (İnceleme Kuyruğu).
 *
 * dynamicQuotaEnabled açık bir sitede günlük sipariş sayısı dinamik eşiği (yeni site için
 * DYNAMIC_MIN_FLOOR=20) aşınca sipariş REDDEDİLMEZ; heldForReview=true ile KABUL edilir ama
 * teslimat YAPILMAZ (atama yok) → admin "İnceleme Kuyruğu"nda Onayla (releaseHeld → completeLine)
 * / Reddet (rejectHeld → satırlar canceled). Bayrak KAPALIYKEN (varsayılan) hiçbir sipariş held
 * olmaz (geriye dönük uyumlu). Bu dosya o hold kararını + admin kuyruk yaşam-döngüsünü kilitler.
 *
 * createOrder(site, dto) kotayı PASING site nesnesinden okur (evaluateQuota: site.dynamicQuotaEnabled
 * / reviewMultiplier / salesDailyQuota); bugünkü sayım orders tablosundan (site.id) gelir. Bu yüzden
 * eşiğe ya 21 gerçek createOrder ile ya da 20 "dolgu" order satırı doğrudan drizzle ile eklenerek varılır.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let products: ProductsService;
let orders: OrdersService;
let admin: AdminOrdersService;

const ACTOR = 'it-quota-actor';

// Nest DI olmadan hafif sahteler (bu testin kapsamı DB davranışı; mail/webhook/redis/security yan etkileri değil).
const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;
// Sert-kota catch'i security.recordQuotaExceeded çağırır (bu dosyada tetiklenmez ama arayüzü karşılansın).
const securityFake = { recordQuotaExceeded: async () => false } as never;

/** dynamicQuotaEnabled açık site + tek ürün + eşleme kurar; createOrder'a verilecek Site nesnesini döndürür. */
async function setupDynamicSite(reviewMultiplier = 3): Promise<{
  siteObj: Site;
  siteId: string;
  product: CreatedProduct;
  remoteProductId: string;
}> {
  const s = await createSite(db, crypto, { tag });
  const product = await createProduct(db, {
    tag,
    kind: 'key',
    usageMode: 'single',
    fulfillmentPolicy: 'partial-auto',
  });
  const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
  await products.createMapping({ siteId: s.id, productId: product.id, remoteProductId });
  const siteObj = {
    id: s.id,
    domain: s.domain,
    salesDailyQuota: null,
    dynamicQuotaEnabled: true,
    reviewMultiplier,
  } as unknown as Site;
  return { siteObj, siteId: s.id, product, remoteProductId };
}

/** Kotasız (bayrak kapalı) site + ürün + eşleme — createOrder her zaman normal (held değil) yolu izler. */
async function setupPlainSite(): Promise<{
  siteObj: Site;
  siteId: string;
  product: CreatedProduct;
  remoteProductId: string;
}> {
  const s = await createSite(db, crypto, { tag });
  const product = await createProduct(db, {
    tag,
    kind: 'key',
    usageMode: 'single',
    fulfillmentPolicy: 'partial-auto',
  });
  const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
  await products.createMapping({ siteId: s.id, productId: product.id, remoteProductId });
  const siteObj = {
    id: s.id,
    domain: s.domain,
    salesDailyQuota: null,
    dynamicQuotaEnabled: false,
    reviewMultiplier: 3,
  } as unknown as Site;
  return { siteObj, siteId: s.id, product, remoteProductId };
}

function makeDto(remoteProductId: string, opts?: { remoteOrderId?: string; qty?: number }): CreateOrderRequest {
  return {
    remoteOrderId: opts?.remoteOrderId ?? `ord-${randomUUID().slice(0, 8)}`,
    customerEmail: `${tag}@example.test`,
    lines: [{ remoteLineId: 'line-1', remoteProductId, qty: opts?.qty ?? 1 }],
  };
}

/**
 * Bugün için `count` adet "dolgu" sipariş satırı DOĞRUDAN ekler (createOrder yolunu tetiklemeden).
 * evaluateQuota yalnız orders tablosunu (site.id + createdAt bugün) saydığından eşiğe hızlı+deterministik
 * varılır. Satır/atama gerekmez (yalnız count'a girer). Tag'li site → cleanupByTag temizler.
 */
async function seedFillerOrdersToday(siteId: string, count: number): Promise<void> {
  const rows = Array.from({ length: count }, () => {
    const rid = `${tagPrefix(tag)}-fill-${randomUUID().slice(0, 8)}`;
    return {
      siteId,
      remoteOrderId: rid,
      customerEmail: `${tag}@example.test`,
      status: 'fulfilled' as const,
      idempotencyKey: `${siteId}:${rid}`,
    };
  });
  await db.insert(schema.orders).values(rows);
}

describe('§8 dinamik kota → held_for_review + İnceleme Kuyruğu', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    products = new ProductsService(db as never);
    const fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    admin = new AdminOrdersService(db as never, redisFake, crypto, mailFake, fulfillment);
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
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('ilk 20 sipariş teslim edilir (held değil), 21. sipariş HELD (202, held=true, atama yok)', async () => {
    const { siteObj, product, remoteProductId } = await setupDynamicSite();
    // 20 gerçek siparişin fulfilment'i için bol stok (21. held → stok tüketmez).
    await insertLicenseItems(db, crypto, { productId: product.id, count: 22, tag });

    // İlk 20: eşik altında → normal akış, fulfilled, held DEĞİL.
    for (let i = 0; i < 20; i++) {
      const res = await orders.createOrder(siteObj, makeDto(remoteProductId));
      expect(res.body.held).not.toBe(true);
      expect(res.body.status).toBe('fulfilled');
      expect(res.httpStatus).toBe(201);
    }

    // 21.: bugün 20 sipariş ≥ eşik (20) → HELD.
    const held = await orders.createOrder(siteObj, makeDto(remoteProductId));
    expect(held.httpStatus).toBe(202);
    expect(held.body.held).toBe(true);
    expect(held.body.status).toBe('pending');
    expect(held.body.assignments).toHaveLength(0);

    // Sipariş satırı held bayrağı + gerekçe; DB'de HİÇ atama yok.
    const [row] = await db
      .select({
        heldForReview: schema.orders.heldForReview,
        heldReason: schema.orders.heldReason,
        heldAt: schema.orders.heldAt,
      })
      .from(schema.orders)
      .where(eq(schema.orders.id, held.body.orderId))
      .limit(1);
    expect(row!.heldForReview).toBe(true);
    expect(row!.heldReason).toBeTruthy();
    expect(row!.heldAt).toBeTruthy();

    const asgs = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(eq(schema.assignments.orderId, held.body.orderId));
    expect(asgs).toHaveLength(0);
  });

  it('dynamicQuotaEnabled=false → sayı ne olursa olsun HİÇBİR sipariş held olmaz', async () => {
    const { siteObj, siteId, remoteProductId, product } = await setupPlainSite();
    await insertLicenseItems(db, crypto, { productId: product.id, count: 2, tag });
    // Eşik tabanının (20) çok üstünde dolgu — bayrak kapalıyken sayım YAPILMAZ (early-return 'allow').
    await seedFillerOrdersToday(siteId, 25);

    const res = await orders.createOrder(siteObj, makeDto(remoteProductId));
    expect(res.body.held).not.toBe(true);
    expect(res.body.status).toBe('fulfilled');

    const [row] = await db
      .select({ heldForReview: schema.orders.heldForReview })
      .from(schema.orders)
      .where(eq(schema.orders.id, res.body.orderId))
      .limit(1);
    expect(row!.heldForReview).toBe(false);
  });

  it('listHeldOrders() held siparişi döndürür', async () => {
    const { siteObj, siteId, remoteProductId } = await setupDynamicSite();
    await seedFillerOrdersToday(siteId, 20);
    const held = await orders.createOrder(siteObj, makeDto(remoteProductId));
    expect(held.body.held).toBe(true);

    const queue = await admin.listHeldOrders();
    const found = queue.find((o) => o.id === held.body.orderId);
    expect(found).toBeDefined();
    expect(found!.siteDomain).toBe(siteObj.domain);
  });

  it('releaseHeld() bayrağı temizler + stok varsa teslim eder (fulfilled + atama oluşur)', async () => {
    const { siteObj, siteId, remoteProductId, product } = await setupDynamicSite();
    await insertLicenseItems(db, crypto, { productId: product.id, count: 2, tag });
    await seedFillerOrdersToday(siteId, 20);
    const held = await orders.createOrder(siteObj, makeDto(remoteProductId));
    expect(held.body.held).toBe(true);

    const res = await admin.releaseHeld(held.body.orderId, ACTOR);
    expect(res.released).toBe(true);

    // Sipariş artık held değil ve teslim edildi.
    const [row] = await db
      .select({ heldForReview: schema.orders.heldForReview, status: schema.orders.status })
      .from(schema.orders)
      .where(eq(schema.orders.id, held.body.orderId))
      .limit(1);
    expect(row!.heldForReview).toBe(false);
    expect(row!.status).toBe('fulfilled');

    // Satıra aktif atama YAZILDI (teslimat başlatıldı).
    const active = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(
        and(
          eq(schema.assignments.orderId, held.body.orderId),
          eq(schema.assignments.status, 'active'),
        ),
      );
    expect(active.length).toBeGreaterThanOrEqual(1);
  });

  it('rejectHeld() → held değil, tüm satırlar canceled, sipariş revoked, atama yok', async () => {
    const { siteObj, siteId, remoteProductId, product } = await setupDynamicSite();
    // Stok VAR ama reddedilen held sipariş teslim ETMEMELİ (atama yazılmaz).
    await insertLicenseItems(db, crypto, { productId: product.id, count: 2, tag });
    await seedFillerOrdersToday(siteId, 20);
    const held = await orders.createOrder(siteObj, makeDto(remoteProductId));
    expect(held.body.held).toBe(true);

    const res = await admin.rejectHeld(held.body.orderId, 'inceleme reddi', ACTOR);
    expect(res.rejected).toBe(true);
    expect(res.status).toBe('revoked');

    const [row] = await db
      .select({ heldForReview: schema.orders.heldForReview, status: schema.orders.status })
      .from(schema.orders)
      .where(eq(schema.orders.id, held.body.orderId))
      .limit(1);
    expect(row!.heldForReview).toBe(false);
    expect(row!.status).toBe('revoked');

    // Tüm satırlar canceled.
    const lines = await db
      .select({ canceled: schema.orderLines.canceled })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, held.body.orderId));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.canceled === true)).toBe(true);

    // Hiç atama yapılmadı.
    const asgs = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(eq(schema.assignments.orderId, held.body.orderId));
    expect(asgs).toHaveLength(0);
  });

  it('releaseHeld/rejectHeld → held OLMAYAN siparişte BadRequestException', async () => {
    const { siteObj, remoteProductId, product } = await setupPlainSite();
    await insertLicenseItems(db, crypto, { productId: product.id, count: 1, tag });
    const normal = await orders.createOrder(siteObj, makeDto(remoteProductId));
    expect(normal.body.held).not.toBe(true);

    await expect(admin.releaseHeld(normal.body.orderId, ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(admin.rejectHeld(normal.body.orderId, 'x', ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
