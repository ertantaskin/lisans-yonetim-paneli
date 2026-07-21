import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateOrderRequest } from '@jetlisans/shared';
import { OrdersService } from '../../src/orders/orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { ProductsService } from '../../src/products/products.service';
import { assignments, siteProductMappings, type Site } from '../../src/db/schema';
import {
  cleanupByTag,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON: OrdersService.createOrder (apps/api/src/orders/orders.service.ts).
 *
 * Nest ayağa KALDIRILMAZ — OrdersService elle new'lenir (gerçek db + gerçek
 * ProductsService/CryptoService). mail/webhook kuyruk bağımlılıkları (Redis/BullMQ)
 * hafif no-op sahtelerle geçilir; createOrder yalnız enqueueDelivery/emit çağırır
 * ve teslimat/webhook mantığı bu testin kapsamı DIŞINDA (atama + idempotency + politika).
 *
 * Kapsam:
 *   (a) Yeterli stok → tüm satırlar fulfilled + benzersiz atama (çifte yok).
 *   (b) Idempotency (site+order) → 2. çağrı YENİ atama üretmez, aynı sonucu döner.
 *   (c) all-or-nothing: stok < talep → HİÇ atama yapılmaz (pending / 202).
 *   (d) partial-auto: kısmi stok → kısmi teslim (207).
 */

const TAG = randomUUID().slice(0, 8);

const { db, end } = makeDb();
const crypto = makeCrypto();

// createOrder yalnız `site.id` kullanır; kuyruk sahteleri no-op.
const mailFake = { enqueueDelivery: async () => {} };
const webhookFake = { emit: async () => {} };
const redisFake = {} as never;

const productsService = new ProductsService(db as never);
// Re-push uzlaştırma (#16) bu iki servisi yeniden kullanır; ilk-push/idempotent testlerinde
// yol dışıdır (adet değişmezse hiç çağrılmaz) ama constructor'a verilmeleri gerekir.
const fulfillmentService = new FulfillmentService(
  db as never,
  productsService,
  mailFake as never,
  webhookFake as never,
);
const adminOrdersService = new AdminOrdersService(
  db as never,
  redisFake,
  crypto,
  mailFake as never,
  fulfillmentService,
);
const orders = new OrdersService(
  db as never,
  productsService,
  crypto,
  mailFake as never,
  webhookFake as never,
  fulfillmentService,
  adminOrdersService,
  // SecurityService (8. arg): sert kota aşımı catch'i best-effort çağırır — bu testte
  // kota ayarlı olmadığından hiç tetiklenmez ama undefined bırakmamak için işlevsel fake.
  { recordQuotaExceeded: async () => false } as never,
);

/** Bu koşuda oluşturulan site id'leri — afterAll'da mapping'leri (restrict FK) temizlemek için. */
const createdSiteIds: string[] = [];

/** Bir site + ürün + eşleme + stok kur; createOrder'a hazır dto üreticisi döndür. */
async function scenario(opts: {
  stock: number;
  fulfillmentPolicy?: 'partial-auto' | 'partial-approval' | 'all-or-nothing';
}) {
  const site = await createSite(db, crypto, { tag: TAG });
  createdSiteIds.push(site.id);
  const product = await createProduct(db, {
    tag: TAG,
    kind: 'key',
    usageMode: 'single',
    fulfillmentPolicy: opts.fulfillmentPolicy ?? 'partial-auto',
  });
  if (opts.stock > 0) {
    await insertLicenseItems(db, crypto, { productId: product.id, count: opts.stock, tag: TAG });
  }
  const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
  await productsService.createMapping({ siteId: site.id, productId: product.id, remoteProductId });

  const siteObj = { id: site.id } as Site;
  const makeDto = (qty: number): CreateOrderRequest => ({
    remoteOrderId: `ord-${randomUUID().slice(0, 8)}`,
    customerEmail: `${TAG}@example.test`,
    lines: [{ remoteLineId: 'line-1', remoteProductId, qty }],
  });

  return { site: siteObj, productId: product.id, remoteProductId, makeDto };
}

/** Belirli siparişe ait atama satırları (benzersizlik + sayım doğrulaması için). */
async function assignmentRows(database: Db, orderId: string) {
  return database
    .select({ id: assignments.id, licenseItemId: assignments.licenseItemId })
    .from(assignments)
    .where(eq(assignments.orderId, orderId));
}

describe('OrdersService.createOrder (entegrasyon)', () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL tanımlı değil — entegrasyon testleri gerçek PostgreSQL gerektirir.');
    }
  });

  afterAll(async () => {
    // cleanupByTag site_product_mappings'i bilmez (products'a restrict FK) → önce mapping'leri sil.
    for (const siteId of createdSiteIds) {
      await db.delete(siteProductMappings).where(eq(siteProductMappings.siteId, siteId));
    }
    await cleanupByTag(db, TAG);
    await end();
  });

  it('(a) yeterli stok → fulfilled + benzersiz atama (çifte atama yok)', async () => {
    const { site, productId, makeDto } = await scenario({ stock: 3 });
    const dto = makeDto(3);

    const { httpStatus, body } = await orders.createOrder(site, dto);

    expect(httpStatus).toBe(201);
    expect(body.status).toBe('fulfilled');
    expect(body.assignments).toHaveLength(3);
    expect(body.lines[0]).toMatchObject({ status: 'fulfilled', requestedQty: 3, fulfilledQty: 3 });

    // DB'de gerçekten 3 atama + hepsi FARKLI license_item (çifte atama = 0).
    const rows = await assignmentRows(db, body.orderId);
    expect(rows).toHaveLength(3);
    const uniqueItems = new Set(rows.map((r) => r.licenseItemId));
    expect(uniqueItems.size).toBe(3);

    // Havuzda 'available' kalmadı; 3 satır 'assigned'.
    const stock = await db.execute<{ status: string; cnt: string }>(sql`
      SELECT status, count(*)::text AS cnt FROM license_items
      WHERE product_id = ${productId} GROUP BY status
    `);
    const byStatus = Object.fromEntries(
      (stock as unknown as Array<{ status: string; cnt: string }>).map((r) => [r.status, Number(r.cnt)]),
    );
    expect(byStatus['assigned']).toBe(3);
    expect(byStatus['available'] ?? 0).toBe(0);
  });

  it('(b) idempotency: aynı site+order 2. çağrı yeni atama üretmez, aynı sonucu döner', async () => {
    const { site, makeDto } = await scenario({ stock: 5 });
    const dto = makeDto(2);

    const first = await orders.createOrder(site, dto);
    expect(first.httpStatus).toBe(201);
    expect(first.body.assignments).toHaveLength(2);

    const firstRows = await assignmentRows(db, first.body.orderId);
    const firstIds = new Set(firstRows.map((r) => r.id));
    expect(firstIds.size).toBe(2);

    // Aynı dto (aynı remoteOrderId) tekrar → idempotent.
    const second = await orders.createOrder(site, dto);

    expect(second.body.orderId).toBe(first.body.orderId);
    expect(second.httpStatus).toBe(first.httpStatus);
    expect(second.body.status).toBe(first.body.status);
    expect(second.body.assignments).toHaveLength(2);

    // DB'de HÂLÂ tam 2 atama — yeni satır YOK, aynı atama id'leri.
    const secondRows = await assignmentRows(db, second.body.orderId);
    expect(secondRows).toHaveLength(2);
    for (const r of secondRows) expect(firstIds.has(r.id)).toBe(true);
  });

  it('(c) all-or-nothing: stok < talep → hiç atama yapılmaz (pending / 202)', async () => {
    const { site, productId, makeDto } = await scenario({
      stock: 2,
      fulfillmentPolicy: 'all-or-nothing',
    });
    const dto = makeDto(3); // 3 istendi, 2 var → all-or-nothing hiçbirini teslim etmez.

    const { httpStatus, body } = await orders.createOrder(site, dto);

    expect(httpStatus).toBe(202);
    expect(body.status).toBe('pending');
    expect(body.assignments).toHaveLength(0);
    expect(body.lines[0]).toMatchObject({ status: 'pending', fulfilledQty: 0 });

    // Hiç atama persist edilmedi; stok geri bırakıldı → 2 satır hâlâ 'available'.
    const rows = await assignmentRows(db, body.orderId);
    expect(rows).toHaveLength(0);
    const [avail] = (await db.execute<{ cnt: string }>(sql`
      SELECT count(*)::text AS cnt FROM license_items
      WHERE product_id = ${productId} AND status = 'available'
    `)) as unknown as Array<{ cnt: string }>;
    expect(Number(avail!.cnt)).toBe(2);
  });

  it('(d) partial-auto: kısmi stok → kısmi teslim (207)', async () => {
    const { site, productId, makeDto } = await scenario({ stock: 2, fulfillmentPolicy: 'partial-auto' });
    const dto = makeDto(3); // 3 istendi, 2 var → 2 teslim, kalan pending.

    const { httpStatus, body } = await orders.createOrder(site, dto);

    expect(httpStatus).toBe(207);
    expect(body.status).toBe('partial');
    expect(body.assignments).toHaveLength(2);
    expect(body.lines[0]).toMatchObject({ status: 'partial', requestedQty: 3, fulfilledQty: 2 });

    // 2 farklı license_item atandı; havuzda available kalmadı.
    const rows = await assignmentRows(db, body.orderId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.licenseItemId)).size).toBe(2);
    const [avail] = (await db.execute<{ cnt: string }>(sql`
      SELECT count(*)::text AS cnt FROM license_items
      WHERE product_id = ${productId} AND status = 'available'
    `)) as unknown as Array<{ cnt: string }>;
    expect(Number(avail!.cnt)).toBe(0);
  });
});
