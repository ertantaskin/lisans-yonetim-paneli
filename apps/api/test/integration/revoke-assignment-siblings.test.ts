import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { MailService } from '../../src/mail/mail.service';
import { ProductsService } from '../../src/products/products.service';
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
 * ENTEGRASYON — per-atama admin iptali ÇOK-ADETLİ satırda kardeşleri öldürmemeli (denetim, orta).
 *
 * Kusur: `revokeAssignment(..., markLineCanceled=true)` satırı KOŞULSUZ `canceled=true` yapıyordu.
 * getDeliveries iptal satırı elediği için, qty=3'lük bir satırda tek anahtarı iptal eden operatör
 * müşterinin elindeki DİĞER İKİ GEÇERLİ anahtarı da müşteri görünümünden düşürüyordu (DB'de hâlâ
 * 'active') — sessiz lisans kaybı.
 *
 * Düzeltme iki yönlü olmalı ve İKİSİ de burada kilitlenir:
 *   (a) kardeş atama kaldıysa satır canceled OLMAZ (müşteri kalan anahtarları görmeye devam eder),
 *   (b) ama qty geri alınan birim kadar DÜŞER → fulfilled == qty ⇒ partial-auto/"Kalanları Ata"
 *       taze anahtarla DOLDURMAZ (H1 bedava-lisans sınıfı korunur).
 * Kardeş kalmadıysa eski davranış aynen sürer: satır terminal (canceled=true).
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let admin: AdminOrdersService;
let fulfillment: FulfillmentService;
let site: CreatedSite;

/** qty birimlik satırı `count` adet aktif atamayla teslim edilmiş duruma kur. */
async function deliverLine(
  productId: string,
  qty: number,
  itemIds: string[],
): Promise<{ orderId: string; lineId: string; assignmentIds: string[] }> {
  const order = await createOrderWithLine(db, {
    siteId: site.id,
    productId,
    qty,
    tag,
    status: 'fulfilled',
  });
  const assignmentIds: string[] = [];
  for (const itemId of itemIds) {
    await db
      .update(schema.licenseItems)
      .set({ status: 'assigned', assignedAt: new Date() })
      .where(eq(schema.licenseItems.id, itemId));
    const [asg] = await db
      .insert(schema.assignments)
      .values({
        orderId: order.orderId,
        lineId: order.lineId,
        licenseItemId: itemId,
        units: 1,
        status: 'active',
        deliveredAt: new Date(),
      })
      .returning({ id: schema.assignments.id });
    assignmentIds.push(asg!.id);
  }
  await db
    .update(schema.orderLines)
    .set({ fulfilledQty: itemIds.length, status: 'fulfilled' })
    .where(eq(schema.orderLines.id, order.lineId));
  return { orderId: order.orderId, lineId: order.lineId, assignmentIds };
}

describe('per-atama iptal: kardeş atamalar korunur, refill açılmaz', () => {
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
    fulfillment = new FulfillmentService(db as never, products, mail, webhook);
    admin = new AdminOrdersService(db as never, fakeRedis, crypto, mail, fulfillment);

    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('3 atamalı satırda 1 iptal → satır canceled OLMAZ, kardeşler aktif kalır, qty 3→2 düşer', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'partial-auto',
    });
    const items = await insertLicenseItems(db, crypto, { productId: product.id, count: 3, tag });
    const { lineId, assignmentIds } = await deliverLine(product.id, 3, items as string[]);

    // Operatör kusurlu TEK anahtarı iptal eder (admin per-atama ucu → markLineCanceled varsayılan true).
    await admin.revokeAssignment(assignmentIds[0]!, 'Anahtar kusurlu', 'admin@test');

    const [line] = await db
      .select({
        canceled: schema.orderLines.canceled,
        qty: schema.orderLines.qty,
        fulfilledQty: schema.orderLines.fulfilledQty,
        status: schema.orderLines.status,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, lineId))
      .limit(1);
    // (a) satır TERMİNAL DEĞİL → getDeliveries kardeşleri elemez (asıl kusur buydu).
    expect(line!.canceled).toBe(false);
    // (b) talep geri alınan birim kadar düştü → fulfilled == qty ⇒ refill kapısı kapalı.
    expect(line!.qty).toBe(2);
    expect(line!.fulfilledQty).toBe(2);
    expect(line!.status).toBe('fulfilled');

    // Kardeş atamalar DOKUNULMADAN aktif.
    const stillActive = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(
        and(eq(schema.assignments.lineId, lineId), eq(schema.assignments.status, 'active')),
      );
    expect(stillActive.length).toBe(2);
    expect(stillActive.map((r) => r.id).sort()).toEqual([assignmentIds[1]!, assignmentIds[2]!].sort());
  });

  it('kardeş kalan satır TAZE stokla doldurulmaz (H1 bedava-lisans sınıfı)', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'partial-auto',
    });
    const items = await insertLicenseItems(db, crypto, { productId: product.id, count: 2, tag });
    const { lineId, assignmentIds } = await deliverLine(product.id, 2, items as string[]);

    await admin.revokeAssignment(assignmentIds[0]!, 'Anahtar kusurlu', 'admin@test');

    // Taze stok gir → tamamlama motorunu çalıştır.
    const [fresh] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      payloadPrefix: 'FRESH',
    });
    await fulfillment.autoCompleteProduct(product.id);

    // Satırda hâlâ YALNIZ kardeş atama var (yeni atama açılmadı) ve taze anahtar harcanmadı.
    const active = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(
        and(eq(schema.assignments.lineId, lineId), eq(schema.assignments.status, 'active')),
      );
    expect(active.length).toBe(1);
    const [freshAfter] = await db
      .select({ status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, fresh!))
      .limit(1);
    expect(freshAfter!.status).toBe('available');
  });

  it('SON aktif atama iptal edilirse satır terminal kalır (canceled=true, qty korunur)', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'partial-auto',
    });
    const items = await insertLicenseItems(db, crypto, { productId: product.id, count: 1, tag });
    const { lineId, assignmentIds } = await deliverLine(product.id, 1, items as string[]);

    await admin.revokeAssignment(assignmentIds[0]!, 'Müşteri iadesi', 'admin@test');

    const [line] = await db
      .select({
        canceled: schema.orderLines.canceled,
        qty: schema.orderLines.qty,
        fulfilledQty: schema.orderLines.fulfilledQty,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, lineId))
      .limit(1);
    expect(line!.canceled).toBe(true);
    expect(line!.qty).toBe(1); // qty'ye DOKUNULMAZ (terminal satırda anlamsız + reconcile zaten atlar)
    expect(line!.fulfilledQty).toBe(0);
  });
});
