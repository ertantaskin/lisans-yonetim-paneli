import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
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
  makeCrypto,
  makeDb,
  type CreatedSite,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — sipariş zaman çizelgesi NEDENSEL SIRADA dönmeli (migration 0044 `seq`).
 *
 * KÖK NEDEN: bir siparişin olayları TEK transaction'da yazılır (`createOrder`: order_received →
 * fulfilled/partially_fulfilled/pending_stock) ve Postgres'te `now()` TRANSACTION BAŞINI
 * döndürür → damgalar BİREBİR AYNI olur. Sıralama yalnız `created_at` ile yapıldığı sürece
 * dönen sıra keyfiydi: sipariş detayında "Geri alındı" satırı "Sipariş tamamlandı"nın ÜSTÜNDE
 * görünebiliyor ve sıra sayfa yenilendikçe değişebiliyordu (dev verisinde aynı damgayı paylaşan
 * 7.200 olay grubu ölçüldü — `fulfilled + line_completed + revoked` üçlüleri dahil).
 *
 * Bu test o düzeltmeyi kilitler: `detail()`'in ORDER BY'ından `seq` çıkarılırsa (ya da 0044
 * geri alınırsa) AYNI damgalı olaylar için sıra garantisi kalmaz.
 *
 * NOT (neden `id` yetmezdi): `id` uuid v4 → kararlı ama RASTGELE sıra verir; nedensel sırayı
 * yalnız monoton `seq` taşır. Aynı karar `license_items.seq` (0030) için de alınmıştı.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let admin: AdminOrdersService;
let site: CreatedSite;

describe('sipariş zaman çizelgesi — aynı damgalı olaylar ekleme sırasında döner (0044 seq)', () => {
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
    const fulfillment = new FulfillmentService(db as never, products, mail, webhook);
    admin = new AdminOrdersService(db as never, fakeRedis, crypto, mail, fulfillment);

    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('aynı damgalı olaylar FİZİKSEL sırayla değil `seq` ile sıralanır', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
    });

    /**
     * AYIRT EDİCİ KURULUM (mutasyonla kanıtlandı — ilk sürüm bu olmadan İŞE YARAMIYORDU).
     *
     * Olayları normal sırayla yazıp "sıra doğru mu" diye bakmak YETMEZ: tie-break OLMADAN da
     * Postgres küçük bir tabloda satırları pratikte fiziksel (= ekleme) sırada döndürür, yani
     * test düzeltme geri alınsa bile YEŞİL kalır. (Bu tam olarak denendi: `.orderBy(createdAt)`
     * hâline döndürüldüğünde ilk sürüm 1/1 geçti — yani hiçbir şeyi korumuyordu.)
     *
     * Bu yüzden `seq` FİZİKSEL SIRANIN TERSİNE açıkça yazılır: heap'te önce duran satırın seq'i
     * BÜYÜK, sonra durananın KÜÇÜK. Artık iki sıra ayrışır ve yalnız ORDER BY'ı gerçekten `seq`
     * içeren sorgu doğru cevabı verebilir. `seq` bigserial'dır; açık değer yazmak sequence'i
     * ilerletmez ve kolonda unique kısıt yoktur — test-yerel, güvenli.
     *
     * Damgalar TEK transaction'da yazıldığı için (now() = transaction başlangıcı) BİREBİR
     * aynıdır; üretimdeki durum da budur (createOrder: order_received + fulfilled/pending_stock).
     */
    const base = 9_000_000_000_000;
    // Fiziksel yazma sırası: revoked → fulfilled → pending_stock → order_received (seq AZALAN).
    // Beklenen görüntüleme sırası bunun TERSİ (seq ARTAN).
    const physical = ['revoked', 'fulfilled', 'pending_stock', 'order_received'] as const;
    await db.transaction(async (tx) => {
      for (let i = 0; i < physical.length; i++) {
        await tx.execute(sql`
          INSERT INTO fulfillment_events (order_id, type, seq)
          VALUES (${order.orderId}, ${physical[i]!}, ${base + (physical.length - i)});
        `);
      }
    });

    // ÖN KOŞUL 1: damgalar gerçekten aynı olmalı — farklı olsalardı sıralamayı `created_at`
    // çözerdi ve `seq` hiç sınanmamış olurdu (test kendi iddiasını doğrulamaz).
    const rows = await db
      .select({ createdAt: schema.fulfillmentEvents.createdAt, seq: schema.fulfillmentEvents.seq })
      .from(schema.fulfillmentEvents)
      .where(eq(schema.fulfillmentEvents.orderId, order.orderId));
    expect(rows).toHaveLength(physical.length);
    expect(new Set(rows.map((r) => r.createdAt!.getTime())).size).toBe(1);

    // ÖN KOŞUL 2: seq gerçekten fiziksel sıranın tersi olmalı (kurulum bozulursa test yalan söylemesin).
    expect(new Set(rows.map((r) => Number(r.seq))).size).toBe(physical.length);

    // ASIL İDDİA: `seq` ARTAN sırası — yani fiziksel sıranın TERSİ.
    const expected = [...physical].reverse();
    const detail = await admin.detail(order.orderId, `it-${tag}`, false);
    expect(detail.events.map((e) => e.type)).toEqual(expected);
  });
});
