import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import type { Site } from '../../src/db/schema';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { PendingLinesService } from '../../src/orders/pending-lines.service';
import { ProductsService } from '../../src/products/products.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  tagPrefix,
  type CreatedSite,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — paket adedi (bundleQty) ÖLÇEK invaryantı (migration 0025 `order_lines.bundle_qty`).
 *
 * `order_lines.qty`/`fulfilled_qty` PANEL birimindedir (= mağaza adedi × bundleQty). Mağazadan
 * gelen her adet MAĞAZA birimindedir. Ölçeği yanlış yerden okumanın iki gerçek sonucu vardı
 * (denetim bulguları) — bu dosya ikisini de kilitler:
 *
 *  [1] ÇİFT ÖLÇEKLEME → BEDAVA LİSANS. `syncRefunds` satır eşlemesiz (product_id NULL) olsa bile
 *      netQty'yi bundleQty ile çarpıp satıra PANEL birimi yazıyordu. Sonra operatör "Eşlemeyi
 *      uygula" deyince `linkLine` aynı qty'yi BİR KEZ DAHA çarpıyor → müşteriye hakkından fazla
 *      lisans teslim ediliyordu.
 *
 *  [2] ÖLÇEK KAYBI → CANLI ANAHTAR GERİ ALINIYOR. Ölçek canlı eşlemeden türetildiği için eşleme
 *      pasifleştirilince/silinince sessizce 1'e düşüyordu; bir sonraki resync satırı "aşırı
 *      teslim" sanıp müşterinin İADE ETMEDİĞİ anahtarları revoke ediyordu (§2 ihlali).
 *
 * Çözüm: ölçek teslimat anında SATIRA yazılır (`bundle_qty`) ve tüketiciler oradan okur;
 * çözülemezse (eski satır + eşleme kaldırılmış) qty'ye DOKUNULMAZ.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let admin: AdminOrdersService;
let pending: PendingLinesService;
let site: CreatedSite;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;

function siteRow(s: CreatedSite): Site {
  return { id: s.id, domain: s.domain } as unknown as Site;
}

describe('bundleQty ölçek invaryantı (order_lines.bundle_qty, 0025)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();

    const products = new ProductsService(db as never);
    const fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    admin = new AdminOrdersService(db as never, redisFake, crypto, mailFake, fulfillment);
    pending = new PendingLinesService(db as never, products, fulfillment);

    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('[1] eşlemesiz satırda kısmi iade ölçeklenmez → sonraki eşleme ÇİFT ölçeklemez', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    await insertLicenseItems(db, crypto, { productId: product.id, count: 20, tag });
    const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;

    // Mağaza ürünü panelde EŞLİ DEĞİLKEN 10 adetlik sipariş geldi → satır MAĞAZA biriminde bekler.
    const remoteOrderId = `${tagPrefix(tag)}-ord-${randomUUID().slice(0, 8)}`;
    const [order] = await db
      .insert(schema.orders)
      .values({
        siteId: site.id,
        remoteOrderId,
        customerEmail: `${tag}@example.test`,
        status: 'unmapped',
        idempotencyKey: `${site.id}:${remoteOrderId}`,
      })
      .returning({ id: schema.orders.id });
    const remoteLineId = `${tagPrefix(tag)}-line-${randomUUID().slice(0, 6)}`;
    const [line] = await db
      .insert(schema.orderLines)
      .values({
        orderId: order!.id,
        productId: null,
        remoteLineId,
        remoteProductId,
        qty: 10, // MAĞAZA birimi
      })
      .returning({ id: schema.orderLines.id });

    // Operatör ürünü paket adedi 3 ile eşler (1 mağaza kalemi = 3 lisans).
    await db.insert(schema.siteProductMappings).values({
      siteId: site.id,
      productId: product.id,
      remoteProductId,
      remoteVariationId: null,
      bundleQty: 3,
      active: true,
    });

    // Müşteri 8 adet iade eder → mağazadan net 2 gelir (MAĞAZA birimi).
    await admin.syncRefunds(siteRow(site), remoteOrderId, [{ remoteLineId, netQty: 2, remoteProductId }], 'iade');

    const [afterRefund] = await db
      .select()
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, line!.id));
    // Satır hâlâ eşlemesiz → MAĞAZA biriminde kalmalı (2), 6 DEĞİL.
    expect(afterRefund!.qty).toBe(2);

    // Şimdi eşleme geriye dönük uygulanır → ölçek TAM BİR KEZ uygulanır: 2 × 3 = 6.
    const res = await pending.resolvePending({ orderId: order!.id }, 'test');
    expect(res.linked).toBe(1);

    const [linked] = await db
      .select()
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, line!.id));
    expect(linked!.qty).toBe(6); // ← çift ölçeklemede 18 olurdu (12 birim bedava lisans)
    expect(linked!.bundleQty).toBe(3); // ölçek artık satıra sabitlendi
    expect(linked!.fulfilledQty).toBe(6);
  });

  it('[2] eşleme pasifleştirilince iade uzlaştırması CANLI anahtarları geri ALMAZ', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    await insertLicenseItems(db, crypto, { productId: product.id, count: 10, tag });
    const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;

    const [mapping] = await db
      .insert(schema.siteProductMappings)
      .values({
        siteId: site.id,
        productId: product.id,
        remoteProductId,
        remoteVariationId: null,
        bundleQty: 3,
        active: true,
      })
      .returning({ id: schema.siteProductMappings.id });

    // Mağaza adedi 2, ölçek 3 → panel satırı 6 birim; 6 birim teslim edilmiş.
    const remoteOrderId = `${tagPrefix(tag)}-ord-${randomUUID().slice(0, 8)}`;
    const [order] = await db
      .insert(schema.orders)
      .values({
        siteId: site.id,
        remoteOrderId,
        customerEmail: `${tag}@example.test`,
        status: 'fulfilled',
        idempotencyKey: `${site.id}:${remoteOrderId}`,
      })
      .returning({ id: schema.orders.id });
    const remoteLineId = `${tagPrefix(tag)}-line-${randomUUID().slice(0, 6)}`;
    const [line] = await db
      .insert(schema.orderLines)
      .values({
        orderId: order!.id,
        productId: product.id,
        remoteLineId,
        remoteProductId,
        qty: 6,
        bundleQty: 3, // teslimat anındaki ölçek anlık görüntüsü
        fulfilledQty: 6,
        status: 'fulfilled',
      })
      .returning({ id: schema.orderLines.id });

    const items = await db
      .select({ id: schema.licenseItems.id })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.productId, product.id))
      .limit(6);
    for (const it of items) {
      await db
        .update(schema.licenseItems)
        .set({ status: 'assigned', assignedAt: new Date() })
        .where(eq(schema.licenseItems.id, it.id));
      await db.insert(schema.assignments).values({
        orderId: order!.id,
        lineId: line!.id,
        licenseItemId: it.id,
        units: 1,
        status: 'active',
        deliveredAt: new Date(),
      });
    }

    // Operatör eşlemeyi PASİFLEŞTİRİR (ürün artık o mağaza kalemine bağlı değil).
    await db
      .update(schema.siteProductMappings)
      .set({ active: false })
      .where(eq(schema.siteProductMappings.id, mapping!.id));

    // Mağaza aynı siparişi yeniden gönderir (iade YOK, net = sipariş adedi = 2).
    await admin.syncRefunds(siteRow(site), remoteOrderId, [{ remoteLineId, netQty: 2, remoteProductId }], 'resync');

    // Ölçek satırdan (3) okunduğu için netQty = 6 = line.qty → iade YOK, revoke YOK.
    const live = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(and(eq(schema.assignments.lineId, line!.id), eq(schema.assignments.status, 'active')));
    expect(live).toHaveLength(6); // ← ölçek kaybında 2'ye düşerdi (4 canlı anahtar boşa gider)

    const [fresh] = await db
      .select()
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, line!.id));
    expect(fresh!.qty).toBe(6);
  });

  it('[2b] anlık görüntüsü OLMAYAN eski satırda eşleme kaldırılmışsa qty’ye DOKUNULMAZ', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    await insertLicenseItems(db, crypto, { productId: product.id, count: 4, tag });
    const remoteProductId = `rp-${randomUUID().slice(0, 8)}`; // hiç eşleme YOK (kaldırılmış)

    const remoteOrderId = `${tagPrefix(tag)}-ord-${randomUUID().slice(0, 8)}`;
    const [order] = await db
      .insert(schema.orders)
      .values({
        siteId: site.id,
        remoteOrderId,
        customerEmail: `${tag}@example.test`,
        status: 'fulfilled',
        idempotencyKey: `${site.id}:${remoteOrderId}`,
      })
      .returning({ id: schema.orders.id });
    const remoteLineId = `${tagPrefix(tag)}-line-${randomUUID().slice(0, 6)}`;
    const [line] = await db
      .insert(schema.orderLines)
      .values({
        orderId: order!.id,
        productId: product.id,
        remoteLineId,
        remoteProductId,
        qty: 4,
        bundleQty: null, // 0025 ÖNCESİ eski satır — ölçek bilinmiyor
        fulfilledQty: 4,
        status: 'fulfilled',
      })
      .returning({ id: schema.orderLines.id });

    await admin.syncRefunds(siteRow(site), remoteOrderId, [{ remoteLineId, netQty: 2, remoteProductId }], 'resync');

    const [fresh] = await db
      .select()
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, line!.id));
    // Ölçek çözülemedi → satır ATLANDI. (Ölçeği 1 saymak qty'yi 2'ye düşürüp 2 canlı anahtarı
    // iade YOKKEN geri alırdı; "belirsizken dokunma" güvenli taraftır.)
    expect(fresh!.qty).toBe(4);
    expect(fresh!.fulfilledQty).toBe(4);
  });
});
