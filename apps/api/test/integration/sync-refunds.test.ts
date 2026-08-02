import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import type { Site } from '../../src/db/schema';
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
  type CreatedProduct,
  type CreatedSite,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — AdminOrdersService.syncRefunds (§2/§7 KISMİ iade uzlaştırması).
 *
 * WooCommerce'te siparişin BAZI birimleri iade edilince WP eklentisi satır-bazlı NET adedi
 * (sipariş qty − iade edilen qty) gönderir. syncRefunds:
 *   1) fazla teslim edilmiş birimleri geri alır (fulfilled > netQty) — tek→karantina, multi→kapasite;
 *   2) satır qty'sini NET'e düşürür → autoComplete iade edilen birimi ARTIK DOLDURMAZ (bedava-lisans
 *      H1-sınıfı kapanır: satır fulfilled=qty olduğundan pending/partial değil, sweep taramaz).
 * İdempotenttir (aynı netQty tekrar → no-op); canceled satır atlanır.
 *
 * Bu dosya o kolu kilitler: qty-düşür + excess-revoke kombinasyonu bozulursa (örn. autoComplete
 * yeniden doldurursa VEYA revoke edilen tek-kullanım key'i karantinaya gitmeyip available'a
 * dönerse) regresyon yakalanır (h1-canceled + revoke-excess-partial kardeş dosyaları).
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let products: ProductsService;
let admin: AdminOrdersService;
let fulfillment: FulfillmentService;
let site: CreatedSite;

// Nest DI olmadan hafif sahteler (bu testin kapsamı DB davranışı; mail/webhook/redis yan etkileri değil).
const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;

/** syncRefunds'a verilecek Site nesnesi (yalnız id + domain kullanılır). */
function siteRow(s: CreatedSite): Site {
  return { id: s.id, domain: s.domain } as unknown as Site;
}

/** Tek-kullanım (single) ürün + N adet teslim edilmiş atama kurar (order+line qty=N fulfilled). */
async function seedSingleDelivered(count: number): Promise<{
  product: CreatedProduct;
  orderId: string;
  lineId: string;
  remoteOrderId: string;
  remoteLineId: string;
  itemIds: string[];
}> {
  const product = await createProduct(db, {
    tag,
    kind: 'key',
    usageMode: 'single',
    fulfillmentPolicy: 'partial-auto',
  });
  const itemIds = await insertLicenseItems(db, crypto, {
    productId: product.id,
    count,
    tag,
    status: 'assigned',
    payloadPrefix: 'DELIVERED',
  });
  const order = await createOrderWithLine(db, {
    siteId: site.id,
    productId: product.id,
    qty: count,
    tag,
    status: 'fulfilled',
  });
  await db
    .insert(schema.assignments)
    .values(
      itemIds.map((liId) => ({
        orderId: order.orderId,
        lineId: order.lineId,
        licenseItemId: liId,
        units: 1,
        status: 'active' as const,
        deliveredAt: new Date(),
      })),
    );
  await db
    .update(schema.orderLines)
    .set({ fulfilledQty: count, status: 'fulfilled' })
    .where(eq(schema.orderLines.id, order.lineId));
  return { product, ...order, itemIds };
}

/** Tek MAK key + tek atama (units) kurar; use_count=units (kapasite tüketilmiş). */
async function seedMultiDelivered(units: number, maxUses: number): Promise<{
  product: CreatedProduct;
  orderId: string;
  lineId: string;
  remoteOrderId: string;
  remoteLineId: string;
  licenseItemId: string;
  assignmentId: string;
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
  return { product, ...order, licenseItemId: licenseItemId!, assignmentId: asg!.id };
}

async function statusCounts(productId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: schema.licenseItems.status })
    .from(schema.licenseItems)
    .where(eq(schema.licenseItems.productId, productId));
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

async function activeCount(lineId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.assignments.id })
    .from(schema.assignments)
    .where(and(eq(schema.assignments.lineId, lineId), eq(schema.assignments.status, 'active')));
  return rows.length;
}

describe('AdminOrdersService.syncRefunds (kısmi iade uzlaştırması)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    products = new ProductsService(db as never);
    fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    admin = new AdminOrdersService(db as never, redisFake, crypto, mailFake, fulfillment);
    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('(a) single qty=3 netQty=2 → 1 fazlalık revoke (karantina), qty=2 fulfilled; autoComplete YENİDEN doldurmaz', async () => {
    const seed = await seedSingleDelivered(3);

    const res = await admin.syncRefunds(
      siteRow(site),
      seed.remoteOrderId,
      [{ remoteLineId: seed.remoteLineId, netQty: 2 }],
      'WooCommerce: partial refund',
    );
    expect(res.orderId).toBe(seed.orderId);
    expect(res.revoked).toBe(1);
    expect(res.adjustedLines).toBe(1);

    // Satır: qty NET'e düştü (2), 2 aktif atama kaldı, fulfilled.
    const [line] = await db
      .select({
        qty: schema.orderLines.qty,
        fulfilledQty: schema.orderLines.fulfilledQty,
        status: schema.orderLines.status,
        canceled: schema.orderLines.canceled,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, seed.lineId))
      .limit(1);
    expect(line!.qty).toBe(2);
    expect(line!.fulfilledQty).toBe(2);
    expect(line!.status).toBe('fulfilled');
    // qty-düşür (kısmi iade) = SATIR canceled DEĞİL (tam iade değil).
    expect(line!.canceled).toBe(false);
    expect(await activeCount(seed.lineId)).toBe(2);

    // İade edilen tek-kullanım key KARANTİNA (available'a DÖNMEZ, §2). 1 quarantined + 2 assigned + 0 available.
    const before = await statusCounts(seed.product.id);
    expect(before['quarantined'] ?? 0).toBe(1);
    expect(before['assigned'] ?? 0).toBe(2);
    expect(before['available'] ?? 0).toBe(0);

    // TAZE stok gir + autoComplete: satır fulfilled (qty=2, fulfilled=2) → sweep taramaz → BEDAVA lisans gitmez.
    const [fresh] = await insertLicenseItems(db, crypto, {
      productId: seed.product.id,
      count: 1,
      tag,
      payloadPrefix: 'FRESH',
    });
    await fulfillment.autoCompleteProduct(seed.product.id);

    // Aktif atama HÂLÂ 2 (yeni atama yok); taze key HÂLÂ available (harcanmadı).
    expect(await activeCount(seed.lineId)).toBe(2);
    const [freshRow] = await db
      .select({ status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, fresh!))
      .limit(1);
    expect(freshRow!.status).toBe('available');
  });

  it('(b) idempotent: aynı netQty tekrar gönderilince değişiklik yok (no-op)', async () => {
    const seed = await seedSingleDelivered(3);

    const first = await admin.syncRefunds(
      siteRow(site),
      seed.remoteOrderId,
      [{ remoteLineId: seed.remoteLineId, netQty: 2 }],
      'iade',
    );
    expect(first.revoked).toBe(1);
    expect(first.adjustedLines).toBe(1);

    // İkinci çağrı: satır qty artık 2 → netQty(2) >= line.qty(2) → bu satırda iade yok → no-op.
    const second = await admin.syncRefunds(
      siteRow(site),
      seed.remoteOrderId,
      [{ remoteLineId: seed.remoteLineId, netQty: 2 }],
      'iade tekrar',
    );
    expect(second.revoked).toBe(0);
    expect(second.adjustedLines).toBe(0);

    // Durum ilk çağrıdakiyle aynı: 2 aktif, 1 karantina.
    expect(await activeCount(seed.lineId)).toBe(2);
    const counts = await statusCounts(seed.product.id);
    expect(counts['quarantined'] ?? 0).toBe(1);
    expect(counts['assigned'] ?? 0).toBe(2);
  });

  it('(c) multi/MAK qty=5 netQty=3 → revokePartialUnits ile 2 birim kapasite döner (atama aktif)', async () => {
    const seed = await seedMultiDelivered(5, 500);

    const res = await admin.syncRefunds(
      siteRow(site),
      seed.remoteOrderId,
      [{ remoteLineId: seed.remoteLineId, netQty: 3 }],
      'kısmi iade (MAK)',
    );
    expect(res.revoked).toBe(2);
    expect(res.adjustedLines).toBe(1);

    // Atama HÂLÂ aktif, units 5→3 (over-revoke YOK). §2 (denetim C2 — kullanıcı kararı): bu bir
    // İADE olduğundan MAK kapasitesi havuza DÖNMEZ → use_count 5'te KALIR (harcanan aktivasyon geri
    // gelmez; sessiz aşırı-satış önlenir). units (3) < use_count (5) farkı = iade edilen ama tüketilmiş
    // aktivasyonlar (beklenen; reconcile yalnız use_count ≤ max_uses kapasite sınırını denetler).
    const [asg] = await db
      .select({ status: schema.assignments.status, units: schema.assignments.units })
      .from(schema.assignments)
      .where(eq(schema.assignments.id, seed.assignmentId))
      .limit(1);
    expect(asg!.status).toBe('active');
    expect(asg!.units).toBe(3);
    const [li] = await db
      .select({ useCount: schema.licenseItems.useCount, status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, seed.licenseItemId))
      .limit(1);
    expect(li!.useCount).toBe(5); // §2: iadede MAK kapasitesi geri DÖNMEZ (eski beklenti 3'tü — davranış bilinçli değişti)

    // Satır: qty=3, fulfilledQty=3, canceled DEĞİL (adet düşür = iade değil).
    const [line] = await db
      .select({
        qty: schema.orderLines.qty,
        fulfilledQty: schema.orderLines.fulfilledQty,
        canceled: schema.orderLines.canceled,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, seed.lineId))
      .limit(1);
    expect(line!.qty).toBe(3);
    expect(line!.fulfilledQty).toBe(3);
    expect(line!.canceled).toBe(false);
  });

  it('(e) bundleQty>1: netQty (sipariş birimi) bundleQty ile PANEL birimine ölçeklenir → doğru revoke', async () => {
    // Panel line.qty=4 (=2 sipariş adedi × bundleQty 2), 4 atama.
    const seed = await seedSingleDelivered(4);
    const remoteProductId = `WOO-${tag}`;
    await db.insert(schema.siteProductMappings).values({
      siteId: site.id,
      productId: seed.product.id,
      remoteProductId,
      bundleQty: 2,
    });

    // 2 sipariş adedi alındı (=4 panel), 1 sipariş adedi iade → net 1 sipariş = 2 PANEL birimi.
    const res = await admin.syncRefunds(
      siteRow(site),
      seed.remoteOrderId,
      [{ remoteLineId: seed.remoteLineId, netQty: 1, remoteProductId }],
      'kısmi iade (bundle)',
    );
    // Denetim düzeltmesi: netQty(1)×bundleQty(2)=2 panel birimi → excess=4−2=2 geri alınır
    // (ölçeklemeseydik netQty=1'i doğrudan qty=4 ile karşılaştırıp 3 birim AŞIRI revoke ederdi).
    expect(res.revoked).toBe(2);
    const [line] = await db
      .select({ qty: schema.orderLines.qty, fulfilledQty: schema.orderLines.fulfilledQty })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, seed.lineId))
      .limit(1);
    expect(line!.qty).toBe(2);
    expect(line!.fulfilledQty).toBe(2);
    expect(await activeCount(seed.lineId)).toBe(2);
  });

  it('(d) canceled (iptal/tam-iade) satır ATLANIR → syncRefunds no-op', async () => {
    const seed = await seedSingleDelivered(3);
    // Satırı terminal 'canceled' işaretle (tam iade / iptal senaryosu).
    await db
      .update(schema.orderLines)
      .set({ canceled: true })
      .where(eq(schema.orderLines.id, seed.lineId));

    const res = await admin.syncRefunds(
      siteRow(site),
      seed.remoteOrderId,
      [{ remoteLineId: seed.remoteLineId, netQty: 1 }],
      'iade — canceled satır',
    );
    expect(res.revoked).toBe(0);
    expect(res.adjustedLines).toBe(0);

    // Hiçbir şey değişmedi: 3 aktif atama, qty hâlâ 3.
    expect(await activeCount(seed.lineId)).toBe(3);
    const [line] = await db
      .select({ qty: schema.orderLines.qty })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, seed.lineId))
      .limit(1);
    expect(line!.qty).toBe(3);
  });
});
