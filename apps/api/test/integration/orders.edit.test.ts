import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateOrderRequest } from '@jetlisans/shared';
import { OrdersService } from '../../src/orders/orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { ProductsService } from '../../src/products/products.service';
import { assignments, orderLines, siteProductMappings, type Site } from '../../src/db/schema';
import {
  cleanupByTag,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  type CreatedProduct,
} from './_helpers';

/**
 * ENTEGRASYON: OrdersService re-push uzlaştırma / sipariş düzenleme (#16).
 *
 * Nest ayağa KALDIRILMAZ — servisler elle new'lenir (gerçek db + gerçek Products/Crypto).
 * Re-push, mevcut atama (FulfillmentService.completeLine) ve idempotent revoke
 * (AdminOrdersService.revokeAssignment) akışlarını YENİDEN KULLANIR; mail/webhook/redis
 * bağımlılıkları no-op sahtelerle geçilir (bu testin kapsamı: adet uzlaştırması).
 *
 * Kapsam:
 *   (a) yeni qty > mevcut → line.qty yükselir + fark partial-auto ile otomatik atanır.
 *   (b) yeni qty < mevcut ve fulfilled > yeni qty → fazla AKTİF atama revoke (karantina).
 *   (c) aynı qty → no-op: yeni atama YOK, order_edited olayı YOK, atama id'leri sabit.
 */

const TAG = randomUUID().slice(0, 8);

const { db, end } = makeDb();
const crypto = makeCrypto();

const mailFake = { enqueueDelivery: async () => {} };
const webhookFake = { emit: async () => {} };
const redisFake = {} as never;

const productsService = new ProductsService(db as never);
const fulfillmentService = new FulfillmentService(
  db as never,
  productsService,
  mailFake as never,
  webhookFake as never,
);
const adminOrdersService = new AdminOrdersService(db as never, redisFake, crypto, mailFake as never);
const orders = new OrdersService(
  db as never,
  productsService,
  crypto,
  mailFake as never,
  webhookFake as never,
  fulfillmentService,
  adminOrdersService,
);

const createdSiteIds: string[] = [];

/** Site + ürün + eşleme + stok kur; SABİT remoteOrderId ile re-push edilebilir dto üreticisi döndür. */
async function scenario(opts: { stock: number }): Promise<{
  site: Site;
  product: CreatedProduct;
  remoteOrderId: string;
  makeDto: (qty: number) => CreateOrderRequest;
}> {
  const site = await createSite(db, crypto, { tag: TAG });
  createdSiteIds.push(site.id);
  const product = await createProduct(db, {
    tag: TAG,
    kind: 'key',
    usageMode: 'single',
    fulfillmentPolicy: 'partial-auto',
  });
  if (opts.stock > 0) {
    await insertLicenseItems(db, crypto, { productId: product.id, count: opts.stock, tag: TAG });
  }
  const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
  await productsService.createMapping({ siteId: site.id, productId: product.id, remoteProductId });

  // domain dâhil — revokeExcess actor'ı `site:<domain>` üretir.
  const siteObj = { id: site.id, domain: site.domain } as Site;
  const remoteOrderId = `ord-${randomUUID().slice(0, 8)}`;
  const makeDto = (qty: number): CreateOrderRequest => ({
    remoteOrderId,
    customerEmail: `${TAG}@example.test`,
    lines: [{ remoteLineId: 'line-1', remoteProductId, qty }],
  });

  return { site: siteObj, product, remoteOrderId, makeDto };
}

async function assignmentRows(orderId: string) {
  return db
    .select({ id: assignments.id, status: assignments.status })
    .from(assignments)
    .where(eq(assignments.orderId, orderId));
}

async function lineRow(orderId: string) {
  const [l] = await db.select().from(orderLines).where(eq(orderLines.orderId, orderId)).limit(1);
  return l!;
}

async function statusCount(productId: string, status: string): Promise<number> {
  const [row] = (await db.execute<{ cnt: string }>(sql`
    SELECT count(*)::text AS cnt FROM license_items
    WHERE product_id = ${productId} AND status = ${status}
  `)) as unknown as Array<{ cnt: string }>;
  return Number(row!.cnt);
}

describe('OrdersService re-push uzlaştırma / sipariş düzenleme (entegrasyon)', () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL tanımlı değil — entegrasyon testleri gerçek PostgreSQL gerektirir.',
      );
    }
  });

  afterAll(async () => {
    for (const siteId of createdSiteIds) {
      await db.delete(siteProductMappings).where(eq(siteProductMappings.siteId, siteId));
    }
    await cleanupByTag(db, TAG);
    await end();
  });

  it('(a) qty artışı → line.qty yükselir + fark otomatik atanır (partial-auto)', async () => {
    const { site, product, makeDto } = await scenario({ stock: 2 });

    const first = await orders.createOrder(site, makeDto(2));
    expect(first.httpStatus).toBe(201);
    expect(first.body.assignments).toHaveLength(2);

    // Yeni stok gelir; aynı sipariş qty=4 ile re-push edilir.
    await insertLicenseItems(db, crypto, { productId: product.id, count: 2, tag: TAG });
    const edited = await orders.createOrder(site, makeDto(4));

    // Aynı sipariş (idempotency key) — yeni sipariş oluşmadı.
    expect(edited.body.orderId).toBe(first.body.orderId);
    expect(edited.httpStatus).toBe(201);
    expect(edited.body.status).toBe('fulfilled');

    const active = (await assignmentRows(first.body.orderId)).filter((a) => a.status === 'active');
    expect(active).toHaveLength(4);

    const line = await lineRow(first.body.orderId);
    expect(line.qty).toBe(4);
    expect(line.fulfilledQty).toBe(4);
    expect(line.status).toBe('fulfilled');

    // 4 farklı key atandı; havuzda available kalmadı.
    expect(await statusCount(product.id, 'available')).toBe(0);
    expect(await statusCount(product.id, 'assigned')).toBe(4);
  });

  it('(b) qty azalışı → fazla aktif atama revoke (karantina), line.qty düşer', async () => {
    const { site, product, makeDto } = await scenario({ stock: 4 });

    const first = await orders.createOrder(site, makeDto(4));
    expect(first.httpStatus).toBe(201);
    expect(first.body.assignments).toHaveLength(4);

    const edited = await orders.createOrder(site, makeDto(2));
    expect(edited.body.orderId).toBe(first.body.orderId);

    const rows = await assignmentRows(first.body.orderId);
    // 4 kayıt kalır (revoke satırı silmez): 2 active + 2 revoked.
    expect(rows).toHaveLength(4);
    expect(rows.filter((a) => a.status === 'active')).toHaveLength(2);
    expect(rows.filter((a) => a.status === 'revoked')).toHaveLength(2);

    const line = await lineRow(first.body.orderId);
    expect(line.qty).toBe(2);
    expect(line.fulfilledQty).toBe(2);
    expect(line.status).toBe('fulfilled');

    // Geri alınan 2 tek-kullanımlık key karantinaya düştü (§2: iade edilen key satışa dönmez).
    expect(await statusCount(product.id, 'quarantined')).toBe(2);
    expect(await statusCount(product.id, 'assigned')).toBe(2);
    expect(await statusCount(product.id, 'available')).toBe(0);
  });

  it('(c) aynı qty → no-op: yeni atama yok, order_edited olayı yok', async () => {
    const { site, makeDto } = await scenario({ stock: 3 });

    const first = await orders.createOrder(site, makeDto(2));
    const firstActive = (await assignmentRows(first.body.orderId))
      .filter((a) => a.status === 'active')
      .map((a) => a.id)
      .sort();
    expect(firstActive).toHaveLength(2);

    const again = await orders.createOrder(site, makeDto(2));
    expect(again.body.orderId).toBe(first.body.orderId);
    expect(again.httpStatus).toBe(first.httpStatus);
    expect(again.body.status).toBe(first.body.status);

    // Atama id'leri değişmedi (yeni atama üretilmedi).
    const secondActive = (await assignmentRows(first.body.orderId))
      .filter((a) => a.status === 'active')
      .map((a) => a.id)
      .sort();
    expect(secondActive).toEqual(firstActive);

    // Değişiklik yolu HİÇ tetiklenmedi → order_edited olayı yazılmadı.
    const [evt] = (await db.execute<{ cnt: string }>(sql`
      SELECT count(*)::text AS cnt FROM fulfillment_events
      WHERE order_id = ${first.body.orderId} AND type = 'order_edited'
    `)) as unknown as Array<{ cnt: string }>;
    expect(Number(evt!.cnt)).toBe(0);
  });
});
