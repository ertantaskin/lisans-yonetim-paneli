import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateOrderRequest } from '@lisans/shared';
import * as schema from '../../src/db/schema';
import type { Site } from '../../src/db/schema';
import { OrdersService } from '../../src/orders/orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { ProductsService } from '../../src/products/products.service';
import {
  cleanupByTag,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  tagPrefix,
  type Db,
} from '../integration/_helpers';

/**
 * YARIŞ TESTİ — §2 held (İnceleme Kuyruğu) sipariş İADE ↔ ONAYLA yarışı (F3 + ABBA deadlock).
 *
 *   Aynı held sipariş için EŞZAMANLI releaseHeld (Onayla → teslim et) + revokeOrderForSite (iade)
 *   → iade edilen siparişte AKTİF atama = 0 (BEDAVA lisans yok) VE deadlock (40P01) atılmaz.
 *
 * F3: releaseHeld held bayrağını (advisory-lock'lu) tx'te temizler ama teslimatı (completeLine)
 * kilit DIŞINDA yapar. İade tam bu pencerede gelirse held=false görüp hiç aktif atama bulamaz →
 * ardından completeLine iade edilmiş siparişe CANLI atama yazabilir. Kapatma: revokeOrderForSite
 * advisory-lock + satır row-lock ile TÜM satırları terminal 'canceled' işaretler + COMMIT SONRASI
 * aktif-atama taraması completeLine'ın yazdığı atamaları da yakalar. ABBA düzeltmesi: her iki yol
 * da kilitleri satır→sipariş sırasıyla alır → eşzamanlılıkta 40P01 üretilmez.
 *
 * assignment.race deseni: modül-kapsamı postgres istemcisi (ayrı bağlantı havuzu → gerçek
 * eşzamanlılık) + gerçek DB. Yarışı çeşitli interleaving'lerde yakalamak için N iterasyon.
 * Migration'lar önceden koşmuş olmalı (db:migrate → test:race).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const ITERATIONS = 25;
const STOCK = 40;
const ACTOR = 'it-held-refund-actor';

// Eşzamanlılığın gerçekten advisory-lock/row-lock'ı tetiklemesi için ayrı bağlantılar (havuz max 20).
const client = postgres(DATABASE_URL ?? '', { max: 20 });
const db = drizzle(client, { schema }) as unknown as Db;

const tag = randomUUID().slice(0, 8);
let orders: OrdersService;
let admin: AdminOrdersService;
let siteObj: Site;
let remoteProductId: string;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;
const securityFake = {
  recordQuotaExceeded: async () => false,
  recordQuotaHeld: async () => false,
} as never;

function isDeadlock(reason: unknown): boolean {
  const s = String(
    (reason as { code?: string; message?: string })?.code ??
      (reason as { message?: string })?.message ??
      reason,
  );
  return /40P01|deadlock/i.test(s);
}

describe('§2 held sipariş iade ↔ onayla yarışı (F3 + ABBA)', () => {
  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL tanımlı değil — held-refund yarış testi gerçek PostgreSQL gerektirir.');
    }
    const crypto = makeCrypto();
    const products = new ProductsService(db as never);
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

    const site = await createSite(db, crypto, { tag });
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'partial-auto',
    });
    remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
    await products.createMapping({ siteId: site.id, productId: product.id, remoteProductId });
    await insertLicenseItems(db, crypto, { productId: product.id, count: STOCK, tag });

    // dynamicQuotaEnabled açık → yeni-site tabanı DYNAMIC_MIN_FLOOR=20. 20 dolgu sipariş bugünü
    // eşiğe getirir → SONRAKİ her createOrder held olur (todayCount ≥ 20).
    const filler = Array.from({ length: 20 }, () => {
      const rid = `${tagPrefix(tag)}-fill-${randomUUID().slice(0, 8)}`;
      return {
        siteId: site.id,
        remoteOrderId: rid,
        customerEmail: `${tag}@example.test`,
        status: 'fulfilled' as const,
        idempotencyKey: `${site.id}:${rid}`,
      };
    });
    await db.insert(schema.orders).values(filler);

    siteObj = {
      id: site.id,
      domain: site.domain,
      salesDailyQuota: null,
      dynamicQuotaEnabled: true,
      reviewMultiplier: 3,
    } as unknown as Site;
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await client.end();
  });

  it(`${ITERATIONS}× eşzamanlı Onayla+İade → held siparişte aktif atama = 0, deadlock yok`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const dto: CreateOrderRequest = {
        remoteOrderId: `ord-${randomUUID().slice(0, 8)}`,
        customerEmail: `${tag}@example.test`,
        lines: [{ remoteLineId: 'line-1', remoteProductId, qty: 1 }],
      };
      const held = await orders.createOrder(siteObj, dto);
      // Eşik aşıldı → held (teslim edilmedi, atama yok).
      expect(held.body.held).toBe(true);
      const orderId = held.body.orderId;

      // EŞZAMANLI: Onayla (teslim et) vs İade (iptal et) — ayrı havuz bağlantılarında.
      const settled = await Promise.allSettled([
        admin.releaseHeld(orderId, ACTOR),
        admin.revokeOrderForSite(siteObj, dto.remoteOrderId, 'WooCommerce: refunded'),
      ]);

      // 1) DEADLOCK YOK: hiçbir reddediliş 40P01 (ABBA) değil. (release'in BadRequest'i meşru → yarışı kaybetti.)
      for (const r of settled) {
        if (r.status === 'rejected') {
          expect(isDeadlock(r.reason)).toBe(false);
        }
      }

      // 2) BEDAVA LİSANS YOK: iade edilen held siparişte AKTİF atama kalmadı.
      const active = await db
        .select({ id: schema.assignments.id })
        .from(schema.assignments)
        .where(and(eq(schema.assignments.orderId, orderId), eq(schema.assignments.status, 'active')));
      expect(active.length).toBe(0);

      // 3) İade her koşulda satırları terminal 'canceled' + sipariş 'revoked' yapar (release kazansa da).
      const [ord] = await db
        .select({ status: schema.orders.status, held: schema.orders.heldForReview })
        .from(schema.orders)
        .where(eq(schema.orders.id, orderId))
        .limit(1);
      expect(ord!.status).toBe('revoked');
      expect(ord!.held).toBe(false);
      const lines = await db
        .select({ canceled: schema.orderLines.canceled })
        .from(schema.orderLines)
        .where(eq(schema.orderLines.orderId, orderId));
      expect(lines.every((l) => l.canceled === true)).toBe(true);
    }
  });
});
