import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import * as schema from '../../src/db/schema';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { MailService } from '../../src/mail/mail.service';
import { ProductsService } from '../../src/products/products.service';
import { ReplacementsService } from '../../src/replacements/replacements.service';
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
 * ENTEGRASYON — ReplacementsService.approve (§13, apps/api/src/replacements/replacements.service.ts).
 *
 * Nest ayağa kalkmaz: bağımlılık servisleri (AdminOrdersService/FulfillmentService/…) gerçek db
 * ile elle new'lenir. Mail/Webhook kuyrukları (BullMQ/Redis) test kapsamı dışı → `add` no-op stub;
 * DB davranışı (revoke → karantina, atomik yeniden atama, stok-yok koruması) gerçek PG'ye karşı test edilir.
 *
 * REGRESYON kapsamı:
 *  (a) SINGLE-use approve → eski atama karantina + YENİ ve FARKLI license_item atanır (aynı key değil).
 *  (b) [AUDIT FIX] MULTI/MAK approve → BadRequestException ('otomatik değişim desteklenmez').
 *  (c) Stok yoksa → ConflictException; talep 'approved' OLMAZ + eski atama korunur.
 */

const tag = randomUUID().slice(0, 8);

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let service: ReplacementsService;
let site: CreatedSite;

const ACTOR = 'it-approve-actor';

/**
 * Teslim edilmiş tek atama seed'i: license_item'i 'assigned' yap, aktif assignment satırı ekle,
 * order_line'ı fulfilled (fulfilledQty=1) yap. Değişimden ÖNCEKİ durumu birebir kurar.
 * assignmentId döner (talep buna bağlanır).
 */
async function seedDeliveredAssignment(opts: {
  orderId: string;
  lineId: string;
  licenseItemId: string;
  units?: number;
}): Promise<string> {
  const units = opts.units ?? 1;
  await db
    .update(schema.licenseItems)
    .set({ status: 'assigned', assignedAt: new Date() })
    .where(eq(schema.licenseItems.id, opts.licenseItemId));
  const [asg] = await db
    .insert(schema.assignments)
    .values({
      orderId: opts.orderId,
      lineId: opts.lineId,
      licenseItemId: opts.licenseItemId,
      units,
      status: 'active',
      deliveredAt: new Date(),
    })
    .returning({ id: schema.assignments.id });
  await db
    .update(schema.orderLines)
    .set({ fulfilledQty: units, status: 'fulfilled' })
    .where(eq(schema.orderLines.id, opts.lineId));
  return asg!.id;
}

/** replacement_request seed'i (doğrudan insert) — site+order+line+assignment'a bağlı, status 'open'. */
async function seedReplacementRequest(opts: {
  orderId: string;
  lineId: string;
  assignmentId: string;
  customerEmail: string;
}): Promise<string> {
  const [row] = await db
    .insert(schema.replacementRequests)
    .values({
      siteId: site.id,
      orderId: opts.orderId,
      lineId: opts.lineId,
      assignmentId: opts.assignmentId,
      customerEmail: opts.customerEmail,
      reason: 'kusurlu key',
      status: 'open',
      withinWarranty: true,
    })
    .returning({ id: schema.replacementRequests.id });
  return row!.id;
}

describe('ReplacementsService.approve (entegrasyon)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();

    // BullMQ kuyruğu (Redis) test kapsamı dışı → add() no-op. Mail email_log'a gerçekten yazar
    // (cascade ile temizlenir); webhook site'de webhookUrl olmadığından erken döner.
    const fakeQueue = { add: async () => undefined } as unknown as Queue;
    const fakeRedis = {} as unknown as Redis;
    // Mail transport testte çağrılmaz (approve mail atmaz); ConfigService yalnız construction için stub.
    const fakeConfig = { get: () => undefined, getOrThrow: () => '' } as never;

    const products = new ProductsService(db as never);
    const mail = new MailService(db as never, fakeQueue, fakeConfig);
    const webhook = new WebhookService(db as never, fakeQueue);
    const fulfillment = new FulfillmentService(db as never, products, mail, webhook);
    const adminOrders = new AdminOrdersService(db as never, fakeRedis, crypto, mail, fulfillment);
    service = new ReplacementsService(db as never, adminOrders, fulfillment, mail);

    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    // replacement_requests site cascade ile düşer; kalanları tag temizliği halleder.
    await cleanupByTag(db, tag);
    await end();
  });

  it('(a) SINGLE-use approve → eski atama karantina + YENİ ve FARKLI license_item atanır', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single', warrantyDays: 30 });
    // 2 stok: A ilk teslim edilen (kusurlu), B değişimde atanacak farklı key.
    const [itemA, itemB] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 2,
      tag,
    });
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
      customerEmail: `a-${tag}@example.test`,
      status: 'fulfilled',
    });
    const oldAsgId = await seedDeliveredAssignment({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: itemA!,
    });
    const reqId = await seedReplacementRequest({
      orderId: order.orderId,
      lineId: order.lineId,
      assignmentId: oldAsgId,
      customerEmail: `a-${tag}@example.test`,
    });

    const updated = await service.approve(reqId, ACTOR);

    // Talep onaylandı + çözen aktör + yeni atama id'si işaretlendi.
    expect(updated.status).toBe('approved');
    expect(updated.resolvedBy).toBe(ACTOR);
    expect(updated.newAssignmentId).toBeTruthy();

    // Eski atama revoke edildi; eski license_item KARANTİNAYA alındı (iade edilen key satışa dönmez, §2).
    const [oldAsg] = await db
      .select({ status: schema.assignments.status, licenseItemId: schema.assignments.licenseItemId })
      .from(schema.assignments)
      .where(eq(schema.assignments.id, oldAsgId))
      .limit(1);
    expect(oldAsg!.status).toBe('revoked');
    expect(oldAsg!.licenseItemId).toBe(itemA);

    const [oldItem] = await db
      .select({ status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, itemA!))
      .limit(1);
    expect(oldItem!.status).toBe('quarantined');

    // Yeni AKTİF atama FARKLI license_item (B) — aynı kusurlu key tekrar verilmedi.
    const [newAsg] = await db
      .select({ id: schema.assignments.id, licenseItemId: schema.assignments.licenseItemId })
      .from(schema.assignments)
      .where(
        and(eq(schema.assignments.lineId, order.lineId), eq(schema.assignments.status, 'active')),
      )
      .orderBy(desc(schema.assignments.createdAt))
      .limit(1);
    expect(newAsg!.id).toBe(updated.newAssignmentId);
    expect(newAsg!.id).not.toBe(oldAsgId);
    expect(newAsg!.licenseItemId).toBe(itemB);
    expect(newAsg!.licenseItemId).not.toBe(itemA);

    // Yeni item 'assigned' oldu.
    const [newItem] = await db
      .select({ status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, itemB!))
      .limit(1);
    expect(newItem!.status).toBe('assigned');
  });

  it('(b) MULTI/MAK approve → BadRequestException (otomatik değişim desteklenmez), durum değişmez', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'multi',
      maxUses: 500,
    });
    const [item] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      maxUses: 500,
    });
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
      customerEmail: `b-${tag}@example.test`,
      status: 'fulfilled',
    });
    // MAK: kapasite tüketilmiş bir atama (item 'assigned' + use_count=1).
    const asgId = await seedDeliveredAssignment({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: item!,
    });
    await db
      .update(schema.licenseItems)
      .set({ useCount: 1 })
      .where(eq(schema.licenseItems.id, item!));
    const reqId = await seedReplacementRequest({
      orderId: order.orderId,
      lineId: order.lineId,
      assignmentId: asgId,
      customerEmail: `b-${tag}@example.test`,
    });

    await expect(service.approve(reqId, ACTOR)).rejects.toBeInstanceOf(BadRequestException);

    // Reddedildi → hiçbir yan etki yok: talep hâlâ 'open', eski atama 'active', item bozulmadı.
    const [req] = await db
      .select({ status: schema.replacementRequests.status })
      .from(schema.replacementRequests)
      .where(eq(schema.replacementRequests.id, reqId))
      .limit(1);
    expect(req!.status).toBe('open');

    const [asg] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.id, asgId))
      .limit(1);
    expect(asg!.status).toBe('active');
  });

  it('(c) stok yoksa → ConflictException; talep approved OLMAZ + eski atama korunur', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    // Tek stok: teslim edilen tek item — değişim için BAŞKA available yok.
    const [item] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
    });
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
      customerEmail: `c-${tag}@example.test`,
      status: 'fulfilled',
    });
    const asgId = await seedDeliveredAssignment({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: item!,
    });
    const reqId = await seedReplacementRequest({
      orderId: order.orderId,
      lineId: order.lineId,
      assignmentId: asgId,
      customerEmail: `c-${tag}@example.test`,
    });

    await expect(service.approve(reqId, ACTOR)).rejects.toBeInstanceOf(ConflictException);

    // Talep açık kaldı (approved yapılmadı).
    const [req] = await db
      .select({ status: schema.replacementRequests.status, newAssignmentId: schema.replacementRequests.newAssignmentId })
      .from(schema.replacementRequests)
      .where(eq(schema.replacementRequests.id, reqId))
      .limit(1);
    expect(req!.status).toBe('open');
    expect(req!.newAssignmentId).toBeNull();

    // Eski atama korunur (revoke edilmedi) + item hâlâ 'assigned' (karantinaya alınmadı).
    const [asg] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.id, asgId))
      .limit(1);
    expect(asg!.status).toBe('active');

    const [li] = await db
      .select({ status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, item!))
      .limit(1);
    expect(li!.status).toBe('assigned');
  });
});
