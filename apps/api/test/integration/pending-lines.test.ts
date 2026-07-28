import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { PendingLinesService } from '../../src/orders/pending-lines.service';
import { MailService } from '../../src/mail/mail.service';
import { ProductsService } from '../../src/products/products.service';
import { WebhookService } from '../../src/webhook/webhook.service';
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
 * ENTEGRASYON — eşleme SONRADAN yapıldığında bekleyen satırların geriye dönük çözümü (§3).
 *
 * Kullanıcının bildirdiği hata: mağaza ürünü panelde eşli değilken gelen sipariş satırı
 * `product_id IS NULL` ile bekler; operatör ürünü sonradan eşlese bile teslimat motoru
 * satırları `product_id` üzerinden taradığı için o satırı ASLA görmez → "Kalanları Ata"
 * "atanacak bir şey yok" der. `PendingLinesService.resolvePending` bu satırı operatörün
 * ELLE kurduğu eşlemeye bağlar ve normal teslimat yolundan geçirir.
 *
 * Bu test dosyası çözümün GÜVENLİK ZARFINI kilitler — bağlama işlemi yeni bir "bedava lisans"
 * yolu AÇMAMALIDIR ([[denetim-regresyon-dersleri]]: H1 sınıfı hatalar 3 kez tekrarladı):
 *   1. mutlu yol       → satır bağlanır + teslim edilir + sipariş fulfilled olur
 *   2. idempotency     → aynı çağrı ikinci kez ÇALIŞMAZ (çifte teslimat yok)
 *   3. canceled satır  → iade/iptal edilmiş satır ASLA bağlanmaz (H1 değişmezi)
 *   4. held sipariş    → inceleme kuyruğundaki sipariş bağlanır ama TESLİM EDİLMEZ
 *   5. eşleme yok      → satıra dokunulmaz, 'no-mapping' olarak dürüst raporlanır
 *      (OTOMATİK EŞLEŞTİRME YOK — panelin değişmez güvenlik kuralı)
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let pending: PendingLinesService;
let site: CreatedSite;

/** Eşlemesiz (product_id NULL) sipariş + satır — gerçek push'un unmapped hâli. */
async function createUnmappedOrder(opts: {
  remoteProductId: string;
  qty?: number;
  canceled?: boolean;
  held?: boolean;
  remoteName?: string;
}): Promise<{ orderId: string; lineId: string }> {
  const remoteOrderId = `${tagPrefix(tag)}-ord-${randomUUID().slice(0, 8)}`;
  const [order] = await db
    .insert(schema.orders)
    .values({
      siteId: site.id,
      remoteOrderId,
      customerEmail: `${tag}@example.test`,
      status: opts.held ? 'held_for_review' : 'unmapped',
      heldForReview: opts.held ?? false,
      idempotencyKey: `${site.id}:${remoteOrderId}`,
    })
    .returning({ id: schema.orders.id });
  const [line] = await db
    .insert(schema.orderLines)
    .values({
      orderId: order!.id,
      productId: null, // ← eşleme yok: teslimat motoru bu satırı GÖRMEZ
      remoteLineId: `${tagPrefix(tag)}-line-${randomUUID().slice(0, 6)}`,
      remoteProductId: opts.remoteProductId,
      remoteName: opts.remoteName ?? 'Mağaza ürünü',
      qty: opts.qty ?? 1,
      canceled: opts.canceled ?? false,
    })
    .returning({ id: schema.orderLines.id });
  return { orderId: order!.id, lineId: line!.id };
}

/** Operatörün ELLE kurduğu eşleme (site + mağaza ürünü → panel ürünü). */
async function createMapping(remoteProductId: string, productId: string): Promise<void> {
  await db.insert(schema.siteProductMappings).values({
    siteId: site.id,
    productId,
    remoteProductId,
    remoteVariationId: null,
    bundleQty: 1,
    active: true,
  });
}

describe('PendingLinesService.resolvePending — eşleme sonrası geriye dönük çözüm', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();

    // BullMQ/mail test kapsamı dışı → no-op stub; DB davranışı gerçek PG'ye karşı koşar.
    const fakeQueue = { add: async () => undefined } as unknown as Queue;
    const fakeConfig = { get: () => undefined, getOrThrow: () => '' } as never;
    const products = new ProductsService(db as never);
    const mail = new MailService(db as never, fakeQueue, fakeConfig);
    const webhook = new WebhookService(db as never, fakeQueue);
    const fulfillment = new FulfillmentService(db as never, products, mail, webhook);
    pending = new PendingLinesService(db as never, products, fulfillment);

    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('eşleme sonradan kurulunca bekleyen satır bağlanır ve teslim edilir', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    await insertLicenseItems(db, crypto, { productId: product.id, count: 1, tag });
    const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
    const { orderId, lineId } = await createUnmappedOrder({ remoteProductId });

    // Eşleme ÖNCESİ: tanı "eşlenmemiş" der, çözülebilir satır yok.
    const before = await pending.diagnose(orderId);
    expect(before.lines[0]!.reason).toBe('unmapped');
    expect(before.resolvableCount).toBe(0);

    // Operatör ürünü ELLE eşler → artık geriye dönük uygulanabilir.
    await createMapping(remoteProductId, product.id);
    const ready = await pending.diagnose(orderId);
    expect(ready.lines[0]!.reason).toBe('mapping-available');
    expect(ready.resolvableCount).toBe(1);

    const res = await pending.resolvePending({ orderId }, 'test');
    expect(res.linked).toBe(1);
    expect(res.delivered).toBe(1);
    expect(res.noMapping).toBe(0);

    const [line] = await db
      .select()
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, lineId));
    expect(line!.productId).toBe(product.id);
    expect(line!.fulfilledQty).toBe(1);
    expect(line!.status).toBe('fulfilled');

    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(order!.status).toBe('fulfilled');

    const assignments = await db
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.lineId, lineId));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.status).toBe('active');
  });

  it('aynı çözüm ikinci kez çalışmaz — ÇİFTE TESLİMAT yok (idempotency)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    // 2 key var: guard bozulursa ikinci çağrı ikinci key'i de teslim edebilirdi.
    await insertLicenseItems(db, crypto, { productId: product.id, count: 2, tag });
    const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
    await createMapping(remoteProductId, product.id);
    const { orderId, lineId } = await createUnmappedOrder({ remoteProductId });

    const first = await pending.resolvePending({ orderId }, 'test');
    expect(first.delivered).toBe(1);

    const second = await pending.resolvePending({ orderId }, 'test');
    expect(second.scanned).toBe(0);
    expect(second.linked).toBe(0);
    expect(second.delivered).toBe(0);

    const assignments = await db
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.lineId, lineId));
    expect(assignments).toHaveLength(1); // ← ikinci key BOŞA gitmedi
  });

  it('iptal/iade edilmiş satır ASLA bağlanmaz (H1 değişmezi — bedava lisans yok)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    await insertLicenseItems(db, crypto, { productId: product.id, count: 1, tag });
    const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
    await createMapping(remoteProductId, product.id);
    const { orderId, lineId } = await createUnmappedOrder({ remoteProductId, canceled: true });

    const res = await pending.resolvePending({ orderId }, 'test');
    expect(res.linked).toBe(0);
    expect(res.delivered).toBe(0);

    const [line] = await db
      .select()
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, lineId));
    expect(line!.productId).toBeNull(); // satıra DOKUNULMADI
    const assignments = await db
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.lineId, lineId));
    expect(assignments).toHaveLength(0);
  });

  it('inceleme kuyruğundaki (held) sipariş bağlansa bile TESLİM EDİLMEZ', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    await insertLicenseItems(db, crypto, { productId: product.id, count: 1, tag });
    const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
    await createMapping(remoteProductId, product.id);
    const { orderId, lineId } = await createUnmappedOrder({ remoteProductId, held: true });

    const res = await pending.resolvePending({ orderId }, 'test');
    expect(res.delivered).toBe(0); // held sipariş teslim edilmez (§8)

    const assignments = await db
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.lineId, lineId));
    expect(assignments).toHaveLength(0);

    // Sipariş hâlâ incelemede — çözüm onu sessizce serbest BIRAKMADI.
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(order!.heldForReview).toBe(true);
  });

  it('eşleme YOKSA satıra dokunulmaz — otomatik eşleştirme yapılmaz (güvenlik)', async () => {
    const remoteProductId = `rp-${randomUUID().slice(0, 8)}`; // hiç eşlenmedi
    const { orderId, lineId } = await createUnmappedOrder({ remoteProductId });

    const res = await pending.resolvePending({ orderId }, 'test');
    expect(res.linked).toBe(0);
    expect(res.noMapping).toBe(1);

    const [line] = await db
      .select()
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, lineId));
    expect(line!.productId).toBeNull();
  });

  it('paket adedi (bundleQty) satır adedini ölçekler', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    await insertLicenseItems(db, crypto, { productId: product.id, count: 3, tag });
    const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
    await db.insert(schema.siteProductMappings).values({
      siteId: site.id,
      productId: product.id,
      remoteProductId,
      remoteVariationId: null,
      bundleQty: 3, // 1 mağaza kalemi = 3 lisans
      active: true,
    });
    const { orderId, lineId } = await createUnmappedOrder({ remoteProductId, qty: 1 });

    const res = await pending.resolvePending({ orderId }, 'test');
    expect(res.delivered).toBe(1);

    const [line] = await db
      .select()
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, lineId));
    expect(line!.qty).toBe(3);
    expect(line!.fulfilledQty).toBe(3);
  });
});
