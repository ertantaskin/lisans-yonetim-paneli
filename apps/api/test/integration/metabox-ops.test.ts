import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import type { Site } from '../../src/db/schema';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { ProductsService } from '../../src/products/products.service';
import { CryptoService } from '../../src/crypto/crypto.service';
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
 * ENTEGRASYON — §7 meta box SITE-SCOPED operasyon katmanı (AdminOrdersService.site*).
 *
 * WP eklentisi bu uçları site HMAC ile çağırır. En kritik güvence: SCOPE — bir site YALNIZ
 * KENDİ siparişinin/atamasının üzerinde işlem yapabilmeli; başka sitenin atamasını reveal/
 * bonus/suspend/replace edememeli (çapraz-site = NotFound). Ayrıca +1 bonus'un `fulfilled ≤ qty`
 * invaryantını (qty ve fulfilled birlikte +1) ve reveal audit izini kilitler.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let products: ProductsService;
let admin: AdminOrdersService;
let siteA: CreatedSite;
let siteB: CreatedSite;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;

function siteRow(s: CreatedSite): Site {
  return { id: s.id, domain: s.domain } as unknown as Site;
}

/**
 * siteA'da qty=1 fulfilled sipariş + 1 aktif atama (ASSIGNED key) + bonus için 1 available key.
 * Döner: remoteOrderId + lineId + assignmentId + atanmış license_item id.
 */
async function seed() {
  const product = await createProduct(db, {
    tag,
    kind: 'key',
    usageMode: 'single',
    fulfillmentPolicy: 'partial-auto',
  });
  const [assignedId] = await insertLicenseItems(db, crypto, {
    productId: product.id,
    count: 1,
    tag,
    status: 'assigned',
    payloadPrefix: 'ASSIGNED',
  });
  // Bonus'un atayabileceği taze available key.
  await insertLicenseItems(db, crypto, {
    productId: product.id,
    count: 1,
    tag,
    status: 'available',
    payloadPrefix: 'BONUS',
  });
  const order = await createOrderWithLine(db, {
    siteId: siteA.id,
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
      licenseItemId: assignedId!,
      units: 1,
      status: 'active',
      deliveredAt: new Date(),
    })
    .returning({ id: schema.assignments.id });
  await db
    .update(schema.orderLines)
    .set({ fulfilledQty: 1, status: 'fulfilled' })
    .where(eq(schema.orderLines.id, order.lineId));
  return { product, order, assignmentId: asg!.id, assignedLicenseItemId: assignedId! };
}

async function activeCount(lineId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.assignments.id })
    .from(schema.assignments)
    .where(and(eq(schema.assignments.lineId, lineId), eq(schema.assignments.status, 'active')));
  return rows.length;
}

describe('§7 meta box site-scoped operasyonlar', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    products = new ProductsService(db as never);
    const fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    admin = new AdminOrdersService(db as never, redisFake, crypto, mailFake, fulfillment);
    siteA = await createSite(db, crypto, { tag });
    siteB = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('SCOPE: başka site (B) A sitesinin atamasını reveal/bonus/suspend EDEMEZ (çapraz-site 404)', async () => {
    const s = await seed();
    const actorB = `wp:admin@${siteB.domain}`;

    await expect(
      admin.siteReveal(siteRow(siteB), s.order.remoteOrderId, s.assignmentId, actorB),
    ).rejects.toThrow();
    await expect(
      admin.siteBonus(siteRow(siteB), s.order.remoteOrderId, s.assignmentId, actorB),
    ).rejects.toThrow();
    await expect(
      admin.siteSuspend(siteRow(siteB), s.order.remoteOrderId, s.assignmentId, true, actorB),
    ).rejects.toThrow();
    // Yanlış remoteOrderId (aynı site) da 404 — atama o siparişe ait değil.
    await expect(
      admin.siteReveal(siteRow(siteA), 'yanlis-remote-id', s.assignmentId, `wp:x@${siteA.domain}`),
    ).rejects.toThrow();

    // Hiçbir yan etki olmadı: atama hâlâ aktif, tek atama.
    const [asg] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.id, s.assignmentId))
      .limit(1);
    expect(asg!.status).toBe('active');
    expect(await activeCount(s.order.lineId)).toBe(1);
  });

  it('reveal: doğru düz payload döner + audit_log reveal kaydı düşer', async () => {
    const s = await seed();
    const actor = `wp:operator@${siteA.domain}`;

    const res = await admin.siteReveal(siteRow(siteA), s.order.remoteOrderId, s.assignmentId, actor);

    // Dönen payload, license_item'ın AAD ile çözülmüş plaintext'ine EŞİT.
    const [li] = await db
      .select({ payloadEnc: schema.licenseItems.payloadEnc })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, s.assignedLicenseItemId))
      .limit(1);
    const expected = crypto.decrypt(
      li!.payloadEnc,
      CryptoService.licenseItemAad(s.assignedLicenseItemId),
    );
    expect(res.payload).toBe(expected);

    // Audit izi: reveal + doğru actor + targetId.
    const audits = await db
      .select({ actor: schema.auditLog.actor })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'reveal'),
          eq(schema.auditLog.targetId, s.assignmentId),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits.some((a) => a.actor === actor)).toBe(true);
  });

  it('suspend/unsuspend: atama durumu askıya al ↔ aktif', async () => {
    const s = await seed();
    const actor = `wp:operator@${siteA.domain}`;

    await admin.siteSuspend(siteRow(siteA), s.order.remoteOrderId, s.assignmentId, true, actor);
    let [asg] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.id, s.assignmentId))
      .limit(1);
    expect(asg!.status).toBe('suspended');

    await admin.siteSuspend(siteRow(siteA), s.order.remoteOrderId, s.assignmentId, false, actor);
    [asg] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.id, s.assignmentId))
      .limit(1);
    expect(asg!.status).toBe('active');
  });

  it('+1 bonus: AYRI sentetik satıra atanır (orijinal Woo satırı ŞİŞMEZ → reconcile/iade dokunmaz)', async () => {
    const s = await seed();
    const actor = `wp:operator@${siteA.domain}`;

    const res = await admin.siteBonus(siteRow(siteA), s.order.remoteOrderId, s.assignmentId, actor);
    expect(res.added).toBe(1);
    // Bonus AYRI bir satıra gitti — orijinal satır id'si DEĞİL.
    expect(res.lineId).not.toBe(s.order.lineId);

    // Orijinal Woo satırı DEĞİŞMEDİ (qty=1, fulfilled=1) → sonraki resync/iade "fazlalık" sanmaz.
    const [orig] = await db
      .select({
        qty: schema.orderLines.qty,
        fulfilledQty: schema.orderLines.fulfilledQty,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, s.order.lineId))
      .limit(1);
    expect(orig!.qty).toBe(1);
    expect(orig!.fulfilledQty).toBe(1);

    // Sentetik bonus satırı: remoteLineId 'bonus:' önekli, qty=fulfilled=1 (invaryant), fulfilled durumda.
    const [bonusLine] = await db
      .select({
        remoteLineId: schema.orderLines.remoteLineId,
        qty: schema.orderLines.qty,
        fulfilledQty: schema.orderLines.fulfilledQty,
        status: schema.orderLines.status,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, res.lineId))
      .limit(1);
    expect(bonusLine!.remoteLineId.startsWith('bonus:')).toBe(true);
    expect(bonusLine!.qty).toBe(1);
    expect(bonusLine!.fulfilledQty).toBe(1);
    expect(bonusLine!.fulfilledQty).toBeLessThanOrEqual(bonusLine!.qty);
    expect(bonusLine!.status).toBe('fulfilled');

    // Sipariş genelinde 2 aktif atama (orijinal + bonus).
    const orderActive = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(
        and(
          eq(schema.assignments.orderId, s.order.orderId),
          eq(schema.assignments.status, 'active'),
        ),
      );
    expect(orderActive.length).toBe(2);
    // Orijinal satırda hâlâ tek atama.
    expect(await activeCount(s.order.lineId)).toBe(1);
  });

  it('+1 bonus: inceleme (held) siparişe bonus verilemez (BadRequest)', async () => {
    const s = await seed();
    await db
      .update(schema.orders)
      .set({ heldForReview: true })
      .where(eq(schema.orders.id, s.order.orderId));

    await expect(
      admin.siteBonus(siteRow(siteA), s.order.remoteOrderId, s.assignmentId, `wp:x@${siteA.domain}`),
    ).rejects.toThrow();

    // Bonus atanmadı: hâlâ tek aktif atama, qty 1.
    expect(await activeCount(s.order.lineId)).toBe(1);
    const [line] = await db
      .select({ qty: schema.orderLines.qty })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, s.order.lineId))
      .limit(1);
    expect(line!.qty).toBe(1);
  });
});
