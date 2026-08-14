import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import * as schema from '../../src/db/schema';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { ProductsService } from '../../src/products/products.service';
import { SupplyOpsService } from '../../src/supply-ops/supply-ops.service';
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
 * ENTEGRASYON — GERİ ÇEKME + TOPLU GEÇERSİZ KILMA kenar durumları (denetim C5 + C6).
 *
 * C5: `recallBatch` yalnız `status='available'` kalemleri void'liyordu. MAK/çok-kullanımlık bir
 *     anahtar kapasitesi dolunca 'depleted' olur → recall ona DOKUNMUYORDU; sonra MEŞRU bir
 *     kapasite iadesi ('depleted' → 'available' CASE'i) onu SATIŞ HAVUZUNA geri sokuyordu, yani
 *     GERİ ÇEKİLMİŞ (kusurlu) partiden yeni müşteriye anahtar teslim edilebiliyordu.
 *     `assign.ts` yüklemi parti/geri-çekme bilmez — bu yüzden kapı kalemin DURUMUNDA tutulur.
 *
 * C6: Toplu stok düşümü yalnız `status='available'` bakıyordu; tekil `voidLicenseItem` ise canlı
 *     atama (active|suspended) varsa 409 verir. MAK'ta kısmen satılmış bir anahtar kapasitesi
 *     bitene kadar 'available' KALDIĞI için, müşterilerde canlı aktivasyonları varken toplu
 *     seçimle 'voided' yapılabiliyordu (tutarsız defter + hayalet zayi).
 */

const tag = randomUUID().slice(0, 8);
const ACTOR = 'panel:it-recall-void';

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let supplyOps: SupplyOpsService;
let admin: AdminOrdersService;
let site: CreatedSite;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;

const batchIds: string[] = [];

async function insertBatch(productId: string): Promise<string> {
  const [row] = await db
    .insert(schema.batches)
    .values({
      productId,
      label: `it-${tag}-batch-${randomUUID().slice(0, 6)}`,
      status: 'active',
      qtyReceived: 0,
    })
    .returning({ id: schema.batches.id });
  batchIds.push(row!.id);
  return row!.id;
}

describe('recallBatch / toplu void — canlı ve tükenmiş kalemler (C5 + C6)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    const products = new ProductsService(db as never);
    const fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    admin = new AdminOrdersService(db as never, redisFake, crypto, mailFake, fulfillment);
    // recallBatch/createAdjustment yalnız this.db kullanır → diğer bağımlılıklar güvenli stub.
    supplyOps = new SupplyOpsService(db as never, undefined as never, undefined as never);
    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    // audit_log izleri FK'siz — targetId=batchId ile temizle; gerisi cleanupByTag.
    if (batchIds.length > 0) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, batchIds));
    }
    await cleanupByTag(db, tag);
    await end();
  });

  it('C5: geri çekilen partideki TÜKENMİŞ (depleted) MAK anahtarı, kapasite iadesiyle satış havuzuna DÖNMEZ', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'multi',
      maxUses: 5,
      fulfillmentPolicy: 'partial-auto',
    });
    const batchId = await insertBatch(product.id);
    const [itemId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      maxUses: 5,
      payloadPrefix: 'RECALL-MAK',
    });
    // Kapasitesi TAMAMEN satılmış MAK anahtarı (use_count = max_uses → 'depleted').
    await db
      .update(schema.licenseItems)
      .set({ useCount: 5, status: 'depleted', batchId })
      .where(eq(schema.licenseItems.id, itemId!));

    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 5,
      tag,
      status: 'fulfilled',
    });
    const [asg] = await db
      .insert(schema.assignments)
      .values({
        orderId: order.orderId,
        lineId: order.lineId,
        licenseItemId: itemId!,
        units: 5,
        status: 'active',
        deliveredAt: new Date(),
      })
      .returning({ id: schema.assignments.id });
    await db
      .update(schema.orderLines)
      .set({ fulfilledQty: 5, status: 'fulfilled' })
      .where(eq(schema.orderLines.id, order.lineId));

    const recall = await supplyOps.recallBatch(batchId, 'tedarikçi hatalı parti', ACTOR);
    // Kalem müşteride canlı → elle değiştirme raporu (§15) korunur.
    expect(recall.soldNeedingReplacement).toBe(1);
    // REGRESYON GUARD: depleted kalem void'lenmezse burası 0 kalır.
    expect(recall.voided).toBe(1);

    const [afterRecall] = await db
      .select({ status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, itemId!))
      .limit(1);
    expect(afterRecall!.status).toBe('voided');

    // Fire miktarı DÜRÜST: satılmış MAK anahtarında kalan kapasite 0 → hayalet 1 birim yazılmaz.
    const [adj] = await db
      .select({ qty: schema.stockAdjustments.qty, reason: schema.stockAdjustments.reason })
      .from(schema.stockAdjustments)
      .where(eq(schema.stockAdjustments.licenseItemId, itemId!))
      .limit(1);
    expect(adj).toBeDefined(); // sebep karantina ekranında görünmeli
    expect(adj!.qty).toBe(0);

    // ŞİMDİ ASIL AÇIK: MEŞRU bir kapasite iadesi (değişim/adet-düşür yolu, returnMultiCapacity=true)
    // 'depleted' → 'available' CASE'ini çalıştırır. Kalem 'voided' olduğu için o CASE ISKALAR.
    await admin.revokePartialUnits(asg!.id, 2, 'adet düşürüldü', ACTOR);
    const [afterReturn] = await db
      .select({ status: schema.licenseItems.status, useCount: schema.licenseItems.useCount })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, itemId!))
      .limit(1);
    expect(afterReturn!.useCount).toBe(3); // kapasite gerçekten döndü (yol bozulmadı)
    // REGRESYON GUARD: 'available' görürsek geri çekilmiş kusurlu anahtar yeniden satılabilir demektir.
    expect(afterReturn!.status).toBe('voided');
  });

  it('C6: toplu geçersiz kılma, müşteride CANLI ataması olan kısmen satılmış MAK anahtarını ATLAR', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'multi',
      maxUses: 5,
      fulfillmentPolicy: 'partial-auto',
    });
    const [liveItem, freeItem] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 2,
      tag,
      maxUses: 5,
      payloadPrefix: 'BULKMAK',
    });
    // liveItem: kısmen satılmış → use_count 2/5, durum HÂLÂ 'available' (MAK'ın doğası).
    await db
      .update(schema.licenseItems)
      .set({ useCount: 2 })
      .where(eq(schema.licenseItems.id, liveItem!));
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 2,
      tag,
      status: 'fulfilled',
    });
    await db.insert(schema.assignments).values({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: liveItem!,
      units: 2,
      status: 'active',
      deliveredAt: new Date(),
    });

    const res = await supplyOps.createAdjustment(
      {
        productId: product.id,
        licenseItemIds: [liveItem!, freeItem!],
        action: 'void',
        qty: 0,
        reason: 'tedarikçi kusurlu parti',
      },
      ACTOR,
    );
    // REGRESYON GUARD: canlı atamalı kalem düşerse affected 2 olur (defter/müşteri çelişir).
    expect(res.requested).toBe(2);
    expect(res.affected).toBe(1);
    expect(res.skipped).toBe(1);

    const rows = await db
      .select({ id: schema.licenseItems.id, status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(inArray(schema.licenseItems.id, [liveItem!, freeItem!]));
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(liveItem!)).toBe('available'); // müşteride canlı → dokunulmaz
    expect(byId.get(freeItem!)).toBe('voided');
  });

  it('C6: seçilenlerin HEPSİ canlıysa 400 (sessizce "başarılı" demez)', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'multi',
      maxUses: 5,
    });
    const [item] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      maxUses: 5,
      payloadPrefix: 'BULKALL',
    });
    await db
      .update(schema.licenseItems)
      .set({ useCount: 1 })
      .where(eq(schema.licenseItems.id, item!));
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
      status: 'fulfilled',
    });
    // 'suspended' de CANLI haktır (askıdaki atama "Geri aç" ile çalışır) → o da korunmalı.
    await db.insert(schema.assignments).values({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: item!,
      units: 1,
      status: 'suspended',
      deliveredAt: new Date(),
    });

    await expect(
      supplyOps.createAdjustment(
        {
          productId: product.id,
          licenseItemIds: [item!],
          action: 'void',
          qty: 0,
          reason: 'kusurlu',
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    const [row] = await db
      .select({ status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, item!))
      .limit(1);
    expect(row!.status).toBe('available');
  });
});
