import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  serializeAccountPayload,
  type AccountPayloadSchema,
  type CreateOrderRequest,
} from '@lisans/shared';
import { CryptoService } from '../../src/crypto/crypto.service';
import { OrdersService } from '../../src/orders/orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { ProductsService } from '../../src/products/products.service';
import * as schema from '../../src/db/schema';
import { assignments, licenseItems, orderLines, type Site } from '../../src/db/schema';
import { cleanupByTag, createProduct, createSite, makeCrypto, makeDb } from './_helpers';

/**
 * ENTEGRASYON — HESAP (account) ÜRÜNÜNDE İADE SEMANTİĞİ (`revokeOrderForSite`).
 *
 * NEDEN: iade yolları key ve MAK için testli (h1-canceled, admin-revoke-refund-semantics,
 * sync-refunds) ama `kind='account'` hiçbirinde yok. Hesap ürünü tek-kullanımlıktır ve iade
 * edilen bir HESAP, kullanıcı adı/parolası müşteride kaldığı için asla yeniden satılamaz —
 * §2'nin "iade edilen key otomatik satışa dönmez" kuralının en kritik olduğu tiptir.
 *
 * TEST GERÇEĞE GÖRE YAZILDI (koddan okunarak, "olması gerekene" göre değil):
 *   `revokeAssignment` `max_uses > 1` DEĞİLSE kalemi `quarantined` yapar → hesap kalemi
 *   KARANTİNAYA gider, havuza DÖNMEZ. Doğrulanan davranış budur; ayrıca karantinadaki
 *   hesabın gerçekten yeniden satılamadığı (yeni sipariş 0 atama alır) da kilitlenir.
 */

const TAG = randomUUID().slice(0, 8);

const { db, end } = makeDb();
const crypto = makeCrypto();

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;

const productsService = new ProductsService(db as never);
const fulfillmentService = new FulfillmentService(
  db as never,
  productsService,
  mailFake,
  webhookFake,
);
const adminOrders = new AdminOrdersService(
  db as never,
  redisFake,
  crypto,
  mailFake,
  fulfillmentService,
);
const orders = new OrdersService(
  db as never,
  productsService,
  crypto,
  mailFake,
  webhookFake,
  fulfillmentService,
  adminOrders,
  { recordQuotaExceeded: async () => false, recordQuotaHeld: async () => false } as never,
);

const ACCOUNT_SCHEMA: AccountPayloadSchema = [
  { key: 'username', label: 'Kullanıcı adı', secret: false, required: true },
  { key: 'password', label: 'Parola', secret: true, required: true },
];

/** Hesap kalemi (kanonik JSON payload — import yolunun ürettiği biçim). */
async function insertAccountItem(productId: string, seed: string): Promise<string> {
  const id = randomUUID();
  const plaintext = serializeAccountPayload(ACCOUNT_SCHEMA, {
    username: `kullanici-${seed}`,
    password: `Parola!${seed}`,
  });
  await db.insert(schema.licenseItems).values({
    id,
    productId,
    payloadEnc: crypto.encrypt(plaintext, CryptoService.licenseItemAad(id)),
    payloadHash: crypto.payloadHash(plaintext),
    payloadSuffixHash: crypto.payloadSuffixHash(plaintext),
    status: 'available',
    maxUses: 1,
  });
  return id;
}

/** Site + hesap ürünü + 1 stok + eşleme; teslim edilmiş tek satırlık sipariş döndürür. */
async function deliveredAccountOrder(seed: string) {
  const created = await createSite(db, crypto, { tag: TAG });
  // revokeOrderForSite actor'ı `site:<domain>` olarak yazar → domain de gerekli.
  const site = { id: created.id, domain: created.domain } as Site;
  const product = await createProduct(db, {
    tag: TAG,
    kind: 'account',
    usageMode: 'single',
    payloadSchema: ACCOUNT_SCHEMA,
  });
  const itemId = await insertAccountItem(product.id, seed);
  const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
  await productsService.createMapping({
    siteId: site.id,
    productId: product.id,
    remoteProductId,
  });

  const dto: CreateOrderRequest = {
    remoteOrderId: `ord-${randomUUID().slice(0, 8)}`,
    customerEmail: `${TAG}@example.test`,
    lines: [{ remoteLineId: 'line-acc', remoteProductId, qty: 1 }],
  };
  const { httpStatus, body } = await orders.createOrder(site, dto);
  expect(httpStatus).toBe(201);
  expect(body.status).toBe('fulfilled');

  return {
    site,
    productId: product.id,
    itemId,
    remoteProductId,
    orderId: body.orderId,
    remoteOrderId: dto.remoteOrderId,
  };
}

describe('Hesap ürününde iade semantiği (entegrasyon)', () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL tanımlı değil — entegrasyon testleri gerçek PostgreSQL gerektirir.',
      );
    }
  });

  afterAll(async () => {
    await cleanupByTag(db, TAG);
    await end();
  });

  it('iade: atama revoked + hesap kalemi KARANTİNAYA gider ve yeniden SATILMAZ', async () => {
    const fx = await deliveredAccountOrder('iade');

    // Teslimat öncesi durum: müşteri hesabı görüyor.
    const before = await orders.getDeliveries(fx.site, fx.orderId);
    expect(before.deliveries).toHaveLength(1);
    expect(before.deliveries[0]!.kind).toBe('account');

    const res = await adminOrders.revokeOrderForSite(fx.site, fx.remoteOrderId, 'müşteri iadesi');
    expect(res).toMatchObject({ orderId: fx.orderId, revoked: 1, assignments: 1 });

    // (1) Atama geri alındı.
    const [asg] = await db
      .select({ status: assignments.status })
      .from(assignments)
      .where(eq(assignments.orderId, fx.orderId));
    expect(asg!.status).toBe('revoked');

    // (2) MEVCUT DAVRANIŞ (koddan okunarak kilitlendi): hesap kalemi tek-kullanımlık olduğu için
    //     havuza DÖNMEZ, 'quarantined' olur. Kullanıcı adı/parola müşteride kaldığından bu doğru
    //     yöndür — kalem 'available'a dönseydi aynı hesap ikinci müşteriye satılırdı.
    const [item] = await db
      .select({ status: licenseItems.status, useCount: licenseItems.useCount })
      .from(licenseItems)
      .where(eq(licenseItems.id, fx.itemId));
    expect(item!.status).toBe('quarantined');
    expect(item!.useCount).toBe(0);

    // (3) Satır terminal 'canceled' (kardeş atama yok) + sayaç sıfır; sipariş 'revoked'.
    const [line] = await db
      .select({
        status: orderLines.status,
        canceled: orderLines.canceled,
        canceledUnits: orderLines.canceledUnits,
        fulfilledQty: orderLines.fulfilledQty,
      })
      .from(orderLines)
      .where(eq(orderLines.orderId, fx.orderId));
    expect(line!.canceled).toBe(true);
    expect(line!.fulfilledQty).toBe(0);
    // Satır zaten terminal işaretlendiği için per-birim iptal defteri şişirilmez.
    expect(line!.canceledUnits).toBe(0);
    const [order] = await db
      .select({ status: schema.orders.status })
      .from(schema.orders)
      .where(eq(schema.orders.id, fx.orderId));
    expect(order!.status).toBe('revoked');

    // (4) Müşteri artık hiçbir şey görmez (arayüzde gizleme değil, veri düzeyinde yok).
    const after = await orders.getDeliveries(fx.site, fx.orderId);
    expect(after.deliveries).toHaveLength(0);
    expect(after.fulfilled).toBe(0);

    // (5) §2 ÇEKİRDEK: karantinadaki hesap YENİDEN SATILAMAZ. Aynı üründen yeni sipariş
    //     (başka stok yok) hiçbir atama almaz — "iade edilen hak otomatik dönmez".
    const resale = await orders.createOrder(fx.site, {
      remoteOrderId: `ord-${randomUUID().slice(0, 8)}`,
      customerEmail: `${TAG}-2@example.test`,
      lines: [{ remoteLineId: 'line-acc', remoteProductId: fx.remoteProductId, qty: 1 }],
    });
    expect(resale.httpStatus).toBe(202);
    expect(resale.body.status).toBe('pending');
    expect(resale.body.assignments).toHaveLength(0);
    // Karantina durumu değişmedi (yeni sipariş kalemi "geri diriltmedi").
    const [stillQuarantined] = await db
      .select({ status: licenseItems.status })
      .from(licenseItems)
      .where(eq(licenseItems.id, fx.itemId));
    expect(stillQuarantined!.status).toBe('quarantined');
  });

  it('iade idempotenttir: ikinci çağrı no-op (revoked=0), kalem karantinada kalır', async () => {
    const fx = await deliveredAccountOrder('idem');

    const first = await adminOrders.revokeOrderForSite(fx.site, fx.remoteOrderId, 'iade');
    expect(first.revoked).toBe(1);

    // WP eklentisi aynı iade olayını tekrar gönderebilir (retry/re-sync) — panel ikinci kez
    // "geri alacak" bir şey bulmamalı; sayaçlar ve kalem durumu DEĞİŞMEMELİ.
    const second = await adminOrders.revokeOrderForSite(fx.site, fx.remoteOrderId, 'iade');
    expect(second.revoked).toBe(0);
    expect(second.assignments).toBe(0);

    const [item] = await db
      .select({ status: licenseItems.status })
      .from(licenseItems)
      .where(eq(licenseItems.id, fx.itemId));
    expect(item!.status).toBe('quarantined');

    const rows = await db
      .select({ status: assignments.status })
      .from(assignments)
      .where(eq(assignments.orderId, fx.orderId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('revoked');
  });
});
