import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import type { Site } from '../../src/db/schema';
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
 * ENTEGRASYON — H1 GERÇEK-İADE canceled=true yolu (audit HIGH: bu kol testsizdi).
 *
 * H1'in çekirdeği: gerçek iade/iptalde (revokeOrderForSite / admin manuel revoke, varsayılan
 * markLineCanceled=true) order_lines.canceled=true işaretlenir → partial-auto tamamlama motoru
 * (autoCompleteProduct/completeLine) iade edilen satırı TAZE key ile YENİDEN DOLDURMAZ. Aksi
 * halde stok girişinde iade edilmiş siparişe bedava lisans teslim edilirdi (doğrudan gelir kaybı).
 *
 * Bu test o kolu kilitler: revokeAssignment bayrağı ters çevrilse veya completeLine/autoComplete'in
 * canceled-atlama guard'ı kaldırılsa BOZULUR → regresyon yakalanır (fa4c05e dersi: her davranış
 * değişikliğinden sonra bu kol koşulmalı; değişim=false yolu replacements.approve.test'te ayrı).
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let admin: AdminOrdersService;
let fulfillment: FulfillmentService;
let site: CreatedSite;

describe('H1 gerçek-iade canceled=true yolu (revokeOrderForSite → autoComplete atlar)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();

    // BullMQ/Redis + mail transport test kapsamı dışı → no-op/stub (DB davranışı gerçek PG'ye karşı).
    const fakeQueue = { add: async () => undefined } as unknown as Queue;
    const fakeRedis = {} as unknown as Redis;
    const fakeConfig = { get: () => undefined, getOrThrow: () => '' } as never;
    const products = new ProductsService(db as never);
    const mail = new MailService(db as never, fakeQueue, fakeConfig);
    const webhook = new WebhookService(db as never, fakeQueue);
    admin = new AdminOrdersService(db as never, fakeRedis, crypto, mail);
    fulfillment = new FulfillmentService(db as never, products, mail, webhook);

    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('iade edilen satır (canceled) stok girince YENİDEN TESLİM EDİLMEZ', async () => {
    // single-use + partial-auto ürün; A teslim edilmiş (kusursuz) key.
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'partial-auto',
    });
    const [itemA] = await insertLicenseItems(db, crypto, { productId: product.id, count: 1, tag });
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
      status: 'fulfilled',
    });

    // A'yı teslim edilmiş kur: item 'assigned', aktif atama, satır fulfilled (fulfilledQty=1).
    await db
      .update(schema.licenseItems)
      .set({ status: 'assigned', assignedAt: new Date() })
      .where(eq(schema.licenseItems.id, itemA!));
    const [asg] = await db
      .insert(schema.assignments)
      .values({
        orderId: order.orderId,
        lineId: order.lineId,
        licenseItemId: itemA!,
        units: 1,
        status: 'active',
        deliveredAt: new Date(),
      })
      .returning({ id: schema.assignments.id });
    await db
      .update(schema.orderLines)
      .set({ fulfilledQty: 1, status: 'fulfilled' })
      .where(eq(schema.orderLines.id, order.lineId));

    // GERÇEK İADE: revokeOrderForSite (varsayılan markLineCanceled=true).
    const siteRow = { id: site.id, domain: site.domain } as unknown as Site;
    const res = await admin.revokeOrderForSite(siteRow, order.remoteOrderId, 'WooCommerce: refunded');
    expect(res.revoked).toBe(1);

    // Atama revoked + itemA karantina (iade edilen key satışa dönmez, §2).
    const [revoked] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.id, asg!.id))
      .limit(1);
    expect(revoked!.status).toBe('revoked');
    const [itemAfter] = await db
      .select({ status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, itemA!))
      .limit(1);
    expect(itemAfter!.status).toBe('quarantined');

    // H1 KİLİDİ: satır 'canceled' işaretli.
    const [lineAfter] = await db
      .select({ canceled: schema.orderLines.canceled })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, order.lineId))
      .limit(1);
    expect(lineAfter!.canceled).toBe(true);

    // TAZE stok gir: B available. partial-auto motoru bunu iade edilen satıra ATAMAMALI.
    const [itemB] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      payloadPrefix: 'FRESH',
    });
    await fulfillment.autoCompleteProduct(product.id);

    // Satırda YENİ aktif atama YOK (canceled → atlanır) → bedava lisans gitmez.
    const activeOnLine = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(
        and(eq(schema.assignments.lineId, order.lineId), eq(schema.assignments.status, 'active')),
      );
    expect(activeOnLine.length).toBe(0);

    // B hâlâ available (harcanmadı).
    const [bAfter] = await db
      .select({ status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, itemB!))
      .limit(1);
    expect(bAfter!.status).toBe('available');
  });
});
