import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { AdminOrdersController } from '../../src/orders/admin-orders.controller';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
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
  type CreatedSite,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — İADE/İPTAL SEMANTİĞİ (denetim C2 + C4).
 *
 * C2: admin MANUEL iptali (`POST /admin/assignments/:id/revoke`) bir İADE'dir. `revokeAssignment`
 *     varsayılanı `returnMultiCapacity=true` olduğundan MAK/çok-kullanımlıkta teslim edilmiş bir
 *     birimi geri alırken `use_count` düşüyor ve kalem yeniden satılabilir hâle geliyordu — oysa
 *     aktivasyon karşı tarafta ZATEN HARCANMIŞTI (§2: "iadede hak otomatik dönmez") → sessiz
 *     aşırı-satış. Kontrol NOKTASI CONTROLLER'dır (servis varsayılanı meşru yeniden-atama yolları
 *     için `true` kalmalı), bu yüzden test controller üzerinden koşar.
 *
 * C4: `rejectHeld` kaçak atamaları ham `UPDATE assignments SET status='revoked'` ile kapatıyordu →
 *     (a) tek-kullanımlık kalem kalıcı 'assigned' limbosunda kalıyordu (SESSİZ STOK KAYBI),
 *     (b) `order_lines.fulfilled_qty` düşmüyordu (reconcile KALICI kritik alarm),
 *     (c) yalnız 'active' süzülüyordu → 'suspended' atama sağ kalıyor, "Geri aç" ile reddedilmiş
 *         siparişte CANLI lisans doğuyordu (H1 sınıfı bedava lisans).
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let admin: AdminOrdersService;
let controller: AdminOrdersController;
let site: CreatedSite;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;

describe('Admin iade/iptal semantiği (C2 + C4)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    const products = new ProductsService(db as never);
    const fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    admin = new AdminOrdersService(db as never, redisFake, crypto, mailFake, fulfillment);
    controller = new AdminOrdersController(admin, fulfillment);
    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('C2: manuel iptal MAK kapasitesini havuza GERİ VERMEZ (§2 — harcanan aktivasyon dönmez)', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'multi',
      maxUses: 500,
      fulfillmentPolicy: 'partial-auto',
    });
    const [licenseItemId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      maxUses: 500,
      payloadPrefix: 'MAK',
    });
    // 3 birim teslim edilmiş MAK anahtarı (use_count=3).
    await db
      .update(schema.licenseItems)
      .set({ useCount: 3 })
      .where(eq(schema.licenseItems.id, licenseItemId!));
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 3,
      tag,
      status: 'fulfilled',
    });
    const [asg] = await db
      .insert(schema.assignments)
      .values({
        orderId: order.orderId,
        lineId: order.lineId,
        licenseItemId: licenseItemId!,
        units: 3,
        status: 'active',
        deliveredAt: new Date(),
      })
      .returning({ id: schema.assignments.id });
    await db
      .update(schema.orderLines)
      .set({ fulfilledQty: 3, status: 'fulfilled' })
      .where(eq(schema.orderLines.id, order.lineId));

    // CONTROLLER üzerinden iptal (gerçek uç sözleşmesi).
    await controller.revoke(asg!.id, { reason: 'müşteri iadesi' }, 'panel:it');

    const [li] = await db
      .select({ useCount: schema.licenseItems.useCount, status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, licenseItemId!))
      .limit(1);
    // REGRESYON GUARD: controller `returnMultiCapacity=false` geçmezse use_count 0'a düşer
    // ve kalem 3 kez daha satılabilir görünür (sessiz aşırı-satış).
    expect(li!.useCount).toBe(3);
    expect(li!.status).toBe('available'); // depleted DEĞİLDİ; recall/void da yok → değişmez

    // Atama gerçekten geri alındı ve satır sayacı düştü.
    const [after] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.id, asg!.id))
      .limit(1);
    expect(after!.status).toBe('revoked');
  });

  it('C4: rejectHeld kaçak atamaları TAM revoke akışıyla kapatır (suspended dahil, stok limbosu yok)', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'partial-auto',
    });
    const itemIds = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 2,
      tag,
      status: 'assigned',
      payloadPrefix: 'HELDSTRAY',
    });
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 2,
      tag,
      status: 'partial',
    });
    // İnceleme kuyruğuna al (held) + bir yarışın bıraktığı iki kaçak atama: biri aktif, biri askıda.
    await db
      .update(schema.orders)
      .set({ heldForReview: true, heldAt: new Date(), heldReason: 'dinamik kota' })
      .where(eq(schema.orders.id, order.orderId));
    await db.insert(schema.assignments).values([
      {
        orderId: order.orderId,
        lineId: order.lineId,
        licenseItemId: itemIds[0]!,
        units: 1,
        status: 'active' as const,
        deliveredAt: new Date(),
      },
      {
        orderId: order.orderId,
        lineId: order.lineId,
        licenseItemId: itemIds[1]!,
        units: 1,
        status: 'suspended' as const,
        deliveredAt: new Date(),
      },
    ]);
    await db
      .update(schema.orderLines)
      .set({ fulfilledQty: 2, status: 'fulfilled' })
      .where(eq(schema.orderLines.id, order.lineId));

    const res = await admin.rejectHeld(order.orderId, 'şüpheli sipariş', 'panel:it');
    expect(res.rejected).toBe(true);
    expect(res.status).toBe('revoked');

    // (c) HİÇBİR atama canlı kalmamalı — 'suspended' de kapanır (aksi halde "Geri aç" ile
    //     reddedilmiş siparişte bedava lisans doğar).
    const live = await db
      .select({ id: schema.assignments.id, status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.orderId, order.orderId));
    expect(live.every((a) => a.status === 'revoked')).toBe(true);

    // (a) Tek-kullanımlık kalemler KARANTİNAYA gider — 'assigned' limbosunda KALMAZ
    //     (ne müşteride ne stokta olan, hiçbir ekranda görünmeyen kayıp anahtar).
    const items = await db
      .select({ id: schema.licenseItems.id, status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.productId, product.id));
    expect(items.length).toBe(2);
    expect(items.every((i) => i.status === 'quarantined')).toBe(true);

    // (b) Satır sayacı sıfırlandı → fulfilled_qty>0 iken ayakta atama 0 çelişkisi (reconcile
    //     kalıcı kritik alarmı) doğmaz. Satır terminal 'canceled'.
    const [line] = await db
      .select({
        fulfilledQty: schema.orderLines.fulfilledQty,
        canceled: schema.orderLines.canceled,
        canceledUnits: schema.orderLines.canceledUnits,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, order.lineId))
      .limit(1);
    expect(line!.fulfilledQty).toBe(0);
    expect(line!.canceled).toBe(true);
    // Satır ZATEN terminal işaretlendiği için defter şişirilmez (gereksiz "N birim iptal" olayı yok).
    expect(line!.canceledUnits).toBe(0);
  });

  it('C4: rejectHeld idempotent kalır (held değilse no-op)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
      status: 'pending',
    });
    await db
      .update(schema.orders)
      .set({ heldForReview: true, heldAt: new Date() })
      .where(eq(schema.orders.id, order.orderId));

    const first = await admin.rejectHeld(order.orderId, 'red', 'panel:it');
    expect(first.rejected).toBe(true);
    const second = await admin.rejectHeld(order.orderId, 'red', 'panel:it');
    expect(second.rejected).toBe(false);

    const stillLive = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(
        and(eq(schema.assignments.orderId, order.orderId), eq(schema.assignments.status, 'active')),
      );
    expect(stillLive.length).toBe(0);
  });
});
