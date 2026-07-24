import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateOrderRequest } from '@jetlisans/shared';
import * as schema from '../../src/db/schema';
import type { Site } from '../../src/db/schema';
import { OrdersService } from '../../src/orders/orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { ProductsService } from '../../src/products/products.service';
import { SalesQuotaExceededException } from '../../src/orders/sales-quota.exception';
import {
  cleanupByTag,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  type Db,
} from '../integration/_helpers';

/**
 * YARIŞ TESTİ — #20 / Finding N: sert günlük satış kotası TOCTOU (advisory-lock sert tavan).
 *
 *   M (> N) eşzamanlı createOrder × salesDailyQuota = N  →  başarılı sipariş ≤ N
 *
 * createOrder, kota özelliği açık sitede bugünkü sipariş sayımını `pg_advisory_xact_lock`
 * ALTINDA yapar (say-sonra-ekle yarışı kapalı). GERÇEK eşzamanlılıkta (Promise.all, ayrı
 * bağlantılar) sert tavanın tutup tutmadığını PostgreSQL'e karşı kanıtlar — advisory-lock
 * kalksa (veya TOCTOU dönerse) N'den fazla sipariş kotayı geçer ve bu test kırılır.
 *
 * Sert tavan aşımı → SalesQuotaExceededException (429); tx ROLLBACK → sipariş satırı OLUŞMAZ
 * (fantom sipariş yok). assignment.race.test.ts deseni: modül-kapsamı postgres istemcisi
 * (ayrı bağlantı havuzu) + gerçek DB. Migration'lar önceden koşmuş olmalı (db:migrate → test:race).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const QUOTA = 5;
const ATTEMPTS = 12; // > QUOTA; pool max (20) altında → bağlantı beklemesi olmadan tam eşzamanlı.

// Eşzamanlılığın gerçekten advisory-lock'ı tetiklemesi için ayrı bağlantılar şart (max 20).
const client = postgres(DATABASE_URL ?? '', { max: 20 });
const db = drizzle(client, { schema }) as unknown as Db;

const tag = randomUUID().slice(0, 8);
let siteId: string;
let siteObj: Site;
let remoteProductId: string;
let orders: OrdersService;

// Bu testin kapsamı DB davranışı; mail/webhook/redis/security yan etkileri değil → hafif sahteler.
const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;
// Sert kota aşımı catch'i security.recordQuotaExceeded çağırır (best-effort); recordQuotaHeld de
// arayüz tamlığı için sahtelenir (dinamik kota bu testte kapalı, tetiklenmez).
const securityFake = {
  recordQuotaExceeded: async () => false,
  recordQuotaHeld: async () => false,
} as never;

describe('#20/Finding N — sert satış kotası TOCTOU (advisory-lock sert tavan, gerçek eşzamanlılık)', () => {
  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL tanımlı değil — TOCTOU yarış testi gerçek PostgreSQL gerektirir.');
    }
    const crypto = makeCrypto();
    const products = new ProductsService(db as never);
    const fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    const admin = new AdminOrdersService(db as never, redisFake, crypto, mailFake, fulfillment);
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

    const site = await createSite(db, crypto, { tag, salesDailyQuota: QUOTA });
    siteId = site.id;
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'partial-auto',
    });
    remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
    await products.createMapping({ siteId: site.id, productId: product.id, remoteProductId });
    // BOL stok (deneme sayısından fazla) → reddedilenler stok DEĞİL yalnızca KOTA nedeniyle reddedilsin.
    await insertLicenseItems(db, crypto, { productId: product.id, count: ATTEMPTS + 5, tag });

    // createOrder kotayı PASING site nesnesinden okur → salesDailyQuota=QUOTA burada set edilir
    // (dinamik kota kapalı → yalnız sert tavan + advisory-lock yolu koşulur).
    siteObj = {
      id: site.id,
      domain: site.domain,
      salesDailyQuota: QUOTA,
      dynamicQuotaEnabled: false,
      reviewMultiplier: 3,
    } as unknown as Site;
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await client.end();
  });

  it(`${ATTEMPTS} eşzamanlı sipariş × kota ${QUOTA} → başarılı ≤ kota (fazlalar 429), fantom sipariş yok`, async () => {
    const dtos: CreateOrderRequest[] = Array.from({ length: ATTEMPTS }, () => ({
      remoteOrderId: `ord-${randomUUID().slice(0, 8)}`, // FARKLI siparişler (idempotent birleşme yok).
      customerEmail: `${tag}@example.test`,
      lines: [{ remoteLineId: 'line-1', remoteProductId, qty: 1 }],
    }));

    // Hepsi AYNI ANDA — advisory-lock say-sonra-ekle yarışını kapatmalı.
    const settled = await Promise.allSettled(dtos.map((d) => orders.createOrder(siteObj, d)));

    const ok = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    // 1) SERT TAVAN: başarılı sipariş sayısı kotayı AŞAMAZ (TOCTOU kapalı) — testin çekirdek invaryantı.
    expect(ok.length).toBeLessThanOrEqual(QUOTA);
    // Bol stok + deterministik advisory-lock serileşmesi → tam olarak kota kadar başarılı.
    expect(ok.length).toBe(QUOTA);

    // 2) Reddedilenlerin HEPSİ kota istisnası (429) — başka bir hata (500/deadlock) değil.
    expect(rejected.length).toBe(ATTEMPTS - QUOTA);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(SalesQuotaExceededException);
      expect((r.reason as SalesQuotaExceededException).getStatus()).toBe(429);
    }

    // 3) DB'de tam olarak kota kadar sipariş kaldı — reddedilenler ROLLBACK (fantom satır YOK).
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.orders)
      .where(eq(schema.orders.siteId, siteId));
    expect(Number(row!.count)).toBe(QUOTA);
  });
});
