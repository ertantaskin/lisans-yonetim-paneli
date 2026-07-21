import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type Redis from 'ioredis';
import { BadRequestException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { MailService } from '../../src/mail/mail.service';
import { ProductsService } from '../../src/products/products.service';
import { SupplyOpsService } from '../../src/supply-ops/supply-ops.service';
import { WebhookService } from '../../src/webhook/webhook.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createOrderWithLine,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  type CreatedSite,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — SupplyOpsService.bulkReplaceBatch (recall sonrası toplu değiştirme, audit MEDIUM).
 *
 * recall.test.ts yalnız recallBatch'i (void/sold sayımı) test eder; asıl DEĞİŞİM makinesi
 * bulkReplaceBatch testsizdi. Bu, fa4c05e'nin uyardığı canceled-flag regresyon sınıfıdır:
 * bulkReplaceBatch her aday için revokeAssignment(...,markLineCanceled=FALSE) + completeLine yapar.
 * Bayrak yanlışlıkla true olursa completeLine canceled satırda no-op → stok VARKEN "stok yok"
 * (skippedNoStock) ve müşteri kusurlu key ile kalır. Bu test o meşru-yeniden-atamayı kilitler.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let svc: SupplyOpsService;
let site: CreatedSite;
const ACTOR = 'it-bulk-actor';
const productIds: string[] = [];
const batchIds: string[] = [];

async function insertBatch(productId: string, status: string): Promise<string> {
  const [row] = await db
    .insert(schema.batches)
    .values({ productId, label: `it-${tag}-batch`, status, qtyReceived: 0 })
    .returning({ id: schema.batches.id });
  batchIds.push(row!.id);
  return row!.id;
}

/** single-use ürün + recalled parti + o partide SATILMIŞ (aktif atamalı) 1 kalem kurar. */
async function seedSoldInRecalledBatch(): Promise<{
  productId: string;
  batchId: string;
  lineId: string;
  assignmentId: string;
  soldItemId: string;
}> {
  const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
  productIds.push(product.id);
  const batchId = await insertBatch(product.id, 'recalled');
  const [soldItemId] = await insertLicenseItems(db, crypto, {
    productId: product.id,
    count: 1,
    tag,
    status: 'assigned',
    payloadPrefix: 'SOLD',
  });
  await db
    .update(schema.licenseItems)
    .set({ batchId })
    .where(eq(schema.licenseItems.id, soldItemId!));
  const order = await createOrderWithLine(db, {
    siteId: site.id,
    productId: product.id,
    qty: 1,
    tag,
    status: 'fulfilled',
  });
  const [asg] = await db
    .insert(schema.assignments)
    .values({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: soldItemId!,
      units: 1,
      status: 'active',
      deliveredAt: new Date(),
    })
    .returning({ id: schema.assignments.id });
  await db
    .update(schema.orderLines)
    .set({ fulfilledQty: 1, status: 'fulfilled' })
    .where(eq(schema.orderLines.id, order.lineId));
  return { productId: product.id, batchId, lineId: order.lineId, assignmentId: asg!.id, soldItemId: soldItemId! };
}

describe('SupplyOpsService.bulkReplaceBatch (recall sonrası toplu değiştirme)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    const fakeQueue = { add: async () => undefined } as unknown as Queue;
    const fakeRedis = {} as unknown as Redis;
    const fakeConfig = { get: () => undefined, getOrThrow: () => '' } as never;
    const products = new ProductsService(db as never);
    const mail = new MailService(db as never, fakeQueue, fakeConfig);
    const webhook = new WebhookService(db as never, fakeQueue);
    const admin = new AdminOrdersService(db as never, fakeRedis, crypto, mail);
    const fulfillment = new FulfillmentService(db as never, products, mail, webhook);
    svc = new SupplyOpsService(db as never, admin, fulfillment);
    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    if (batchIds.length > 0) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, batchIds));
    }
    if (productIds.length > 0) {
      await db.delete(schema.stockAdjustments).where(inArray(schema.stockAdjustments.productId, productIds));
      await db.delete(schema.batches).where(inArray(schema.batches.productId, productIds));
    }
    await cleanupByTag(db, tag);
    await end();
  });

  it('yedek stok VARKEN → replaced=1, eski karantina, satırda YENİ+FARKLI aktif atama, canceled=FALSE', async () => {
    const seed = await seedSoldInRecalledBatch();
    // Başka partiden (batch_id NULL) available yedek — aday olur (IS DISTINCT FROM batchId).
    const [spareId] = await insertLicenseItems(db, crypto, {
      productId: seed.productId,
      count: 1,
      tag,
      status: 'available',
      payloadPrefix: 'SPARE',
    });

    const res = await svc.bulkReplaceBatch(seed.batchId, ACTOR);
    expect(res.replaced).toBe(1);
    expect(res.skippedNoStock).toBe(0);
    expect(res.skippedUnsupported).toBe(0);

    // Eski atama revoked + eski kalem karantina.
    const [oldAsg] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.id, seed.assignmentId))
      .limit(1);
    expect(oldAsg!.status).toBe('revoked');
    const [oldItem] = await db
      .select({ status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, seed.soldItemId))
      .limit(1);
    expect(oldItem!.status).toBe('quarantined');

    // Satırda YENİ aktif atama, FARKLI (yedek) license_item — meşru yeniden-atama çalıştı.
    const [newAsg] = await db
      .select({ id: schema.assignments.id, licenseItemId: schema.assignments.licenseItemId })
      .from(schema.assignments)
      .where(and(eq(schema.assignments.lineId, seed.lineId), eq(schema.assignments.status, 'active')))
      .orderBy(desc(schema.assignments.createdAt))
      .limit(1);
    expect(newAsg!.licenseItemId).toBe(spareId);
    expect(newAsg!.licenseItemId).not.toBe(seed.soldItemId);

    // KRİTİK: satır 'canceled' DEĞİL (değişim iadedeğil → completeLine no-op'lanmamalı).
    const [line] = await db
      .select({ canceled: schema.orderLines.canceled })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, seed.lineId))
      .limit(1);
    expect(line!.canceled).toBe(false);
  });

  it('yedek stok YOKKEN → skippedNoStock=1, eski atama korunur (revoke edilmez)', async () => {
    const seed = await seedSoldInRecalledBatch();
    // Yedek stok yok (recalled partideki tek kalem satılmış; aday available yok).
    const res = await svc.bulkReplaceBatch(seed.batchId, ACTOR);
    expect(res.replaced).toBe(0);
    expect(res.skippedNoStock).toBe(1);

    // Eski atama korunur (revoke etmeden atlandı → müşteri boşta kalmaz).
    const [asg] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.id, seed.assignmentId))
      .limit(1);
    expect(asg!.status).toBe('active');
  });

  it("hedef parti 'active' (recalled değil) → BadRequestException", async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    productIds.push(product.id);
    const activeBatchId = await insertBatch(product.id, 'active');
    await expect(svc.bulkReplaceBatch(activeBatchId, ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
