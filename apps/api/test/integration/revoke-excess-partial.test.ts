import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
  createOrderWithLine,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  type CreatedProduct,
  type CreatedSite,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — #19 BİRİM-GRANÜLER kısmi revoke (multi / MAK).
 *
 * Çok-kullanımlı (multi) üründe tek MAK key birden çok birim taşır: qty=5 sipariş → TEK atama units=5
 * (aynı key'ten). Re-push ile adet 3'e DÜŞÜRÜLÜNCE reconcileOrder.revokeExcess artık atamanın TAMAMINI
 * revoke ETMEMELİ (eski over-revoke bug'ı: müşteri hakkını fazladan kaybederdi) — yalnız fazla 2 birimi
 * AdminOrdersService.revokePartialUnits ile geri almalı: atama units=3 AKTİF kalır, kapasite (use_count)
 * tam 2 döner, satır fulfilledQty=3, satır 'canceled' DEĞİL (adet düşür = iade değil). Tek-kullanımda
 * (a.units=1) bu dala hiç girilmez → eski davranış birebir korunur.
 *
 * revokePartialUnits doğrudan da test edilir: kısmi (units<atama.units) → units azaltılır, partial:true;
 * tam (units>=atama.units) → status 'revoked', partial:false.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let products: ProductsService;
let orders: OrdersService;
let admin: AdminOrdersService;
let site: CreatedSite;

const ACTOR = 'it-revoke-excess-actor';

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;
const securityFake = { recordQuotaExceeded: async () => false } as never;

/** createOrder'a verilecek kotasız Site nesnesi (evaluateQuota early-return 'allow'). */
function siteObjOf(s: CreatedSite): Site {
  return {
    id: s.id,
    domain: s.domain,
    salesDailyQuota: null,
    dynamicQuotaEnabled: false,
    reviewMultiplier: 3,
  } as unknown as Site;
}

/** multi ürün + tek MAK key (maxUses) + eşleme kurar. */
async function setupMultiProduct(maxUses: number): Promise<{
  product: CreatedProduct;
  licenseItemId: string;
  remoteProductId: string;
}> {
  const product = await createProduct(db, {
    tag,
    kind: 'key',
    usageMode: 'multi',
    maxUses,
    fulfillmentPolicy: 'partial-auto',
  });
  const [licenseItemId] = await insertLicenseItems(db, crypto, {
    productId: product.id,
    count: 1,
    tag,
    maxUses,
  });
  const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
  await products.createMapping({ siteId: site.id, productId: product.id, remoteProductId });
  return { product, licenseItemId: licenseItemId!, remoteProductId };
}

/** Doğrudan (createOrder'sız) tek MAK atama kurar: order+line qty=units fulfilled, atama units, use_count=units. */
async function seedMultiAssignment(units: number, maxUses: number): Promise<{
  assignmentId: string;
  lineId: string;
  orderId: string;
  licenseItemId: string;
  productId: string;
}> {
  const product = await createProduct(db, {
    tag,
    kind: 'key',
    usageMode: 'multi',
    maxUses,
    fulfillmentPolicy: 'partial-auto',
  });
  const [licenseItemId] = await insertLicenseItems(db, crypto, {
    productId: product.id,
    count: 1,
    tag,
    maxUses,
  });
  // Kapasiteyi elle "tüketilmiş" kur (units kadar kullanım).
  await db
    .update(schema.licenseItems)
    .set({ useCount: units })
    .where(eq(schema.licenseItems.id, licenseItemId!));
  const order = await createOrderWithLine(db, {
    siteId: site.id,
    productId: product.id,
    qty: units,
    tag,
    status: 'fulfilled',
  });
  const [asg] = await db
    .insert(schema.assignments)
    .values({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: licenseItemId!,
      units,
      status: 'active',
      deliveredAt: new Date(),
    })
    .returning({ id: schema.assignments.id });
  await db
    .update(schema.orderLines)
    .set({ fulfilledQty: units, status: 'fulfilled' })
    .where(eq(schema.orderLines.id, order.lineId));
  return {
    assignmentId: asg!.id,
    lineId: order.lineId,
    orderId: order.orderId,
    licenseItemId: licenseItemId!,
    productId: product.id,
  };
}

async function assignmentRow(id: string) {
  const [row] = await db
    .select({ status: schema.assignments.status, units: schema.assignments.units })
    .from(schema.assignments)
    .where(eq(schema.assignments.id, id))
    .limit(1);
  return row!;
}

async function licenseItemRow(id: string) {
  const [row] = await db
    .select({ useCount: schema.licenseItems.useCount, status: schema.licenseItems.status })
    .from(schema.licenseItems)
    .where(eq(schema.licenseItems.id, id))
    .limit(1);
  return row!;
}

async function lineRow(id: string) {
  const [row] = await db
    .select({
      fulfilledQty: schema.orderLines.fulfilledQty,
      canceled: schema.orderLines.canceled,
      qty: schema.orderLines.qty,
    })
    .from(schema.orderLines)
    .where(eq(schema.orderLines.id, id))
    .limit(1);
  return row!;
}

describe('#19 birim-granüler kısmi revoke (multi/MAK)', () => {
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
    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('re-push qty 5→3 (multi) → atama units=3 AKTİF, use_count=3, satır fulfilledQty=3, canceled=false', async () => {
    const { product, licenseItemId, remoteProductId } = await setupMultiProduct(500);
    const siteObj = siteObjOf(site);
    const remoteOrderId = `ord-${randomUUID().slice(0, 8)}`;

    const dto = (qty: number): CreateOrderRequest => ({
      remoteOrderId,
      customerEmail: `${tag}@example.test`,
      lines: [{ remoteLineId: 'line-1', remoteProductId, qty }],
    });

    // qty=5 → TEK atama units=5 (aynı MAK key), use_count=5.
    const first = await orders.createOrder(siteObj, dto(5));
    expect(first.httpStatus).toBe(201);
    expect(first.body.status).toBe('fulfilled');
    expect(first.body.assignments).toHaveLength(1);
    expect(first.body.assignments[0]!.units).toBe(5);
    expect((await licenseItemRow(licenseItemId)).useCount).toBe(5);

    const asgId = first.body.assignments[0]!.assignmentId;

    // Aynı siparişi qty=3 ile re-push → fazla 2 birim BİRİM-GRANÜLER geri alınır (atama imha EDİLMEZ).
    const edited = await orders.createOrder(siteObj, dto(3));
    expect(edited.body.orderId).toBe(first.body.orderId);

    // Atama HÂLÂ aktif ve units=3 (revoke edilmedi).
    const asg = await assignmentRow(asgId);
    expect(asg.status).toBe('active');
    expect(asg.units).toBe(3);

    // Kapasite tam 2 döndü (5→3), 5 değil.
    expect((await licenseItemRow(licenseItemId)).useCount).toBe(3);

    // Satır: fulfilledQty=3, qty=3, canceled DEĞİL (adet düşür = iade değil).
    const [ol] = await db
      .select({
        fulfilledQty: schema.orderLines.fulfilledQty,
        qty: schema.orderLines.qty,
        canceled: schema.orderLines.canceled,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, edited.body.orderId))
      .limit(1);
    expect(ol!.fulfilledQty).toBe(3);
    expect(ol!.qty).toBe(3);
    expect(ol!.canceled).toBe(false);
    // product yalnız setup içindi; burada ayrıca kullanılmıyor.
    void product;
  });

  it('revokePartialUnits: units<atama.units → kısmi (units azaltılır, partial:true, atama aktif)', async () => {
    const seed = await seedMultiAssignment(5, 500);

    const res = await admin.revokePartialUnits(seed.assignmentId, 2, 'kısmi geri al', ACTOR);
    expect(res.revoked).toBe(2);
    expect(res.partial).toBe(true);

    const asg = await assignmentRow(seed.assignmentId);
    expect(asg.status).toBe('active');
    expect(asg.units).toBe(3);

    expect((await licenseItemRow(seed.licenseItemId)).useCount).toBe(3);

    const line = await lineRow(seed.lineId);
    expect(line.fulfilledQty).toBe(3); // 5 - 2
    expect(line.canceled).toBe(false);
  });

  it('revokePartialUnits: units>=atama.units → tam revoke (status revoked, partial:false)', async () => {
    const seed = await seedMultiAssignment(4, 500);

    // units (10) >= atama.units (4) → tam revoke.
    const res = await admin.revokePartialUnits(seed.assignmentId, 10, 'tamamını geri al', ACTOR);
    expect(res.revoked).toBe(4);
    expect(res.partial).toBe(false);

    const asg = await assignmentRow(seed.assignmentId);
    expect(asg.status).toBe('revoked');

    // MAK key: tam revoke'ta kapasite geri döner (use_count -= take) — tükenmiş değildi, karantina olmaz.
    expect((await licenseItemRow(seed.licenseItemId)).useCount).toBe(0);

    const line = await lineRow(seed.lineId);
    expect(line.fulfilledQty).toBe(0); // 4 - 4
    expect(line.canceled).toBe(false);
  });
});
