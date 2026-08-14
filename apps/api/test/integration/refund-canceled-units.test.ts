import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import type { Site } from '../../src/db/schema';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { ProductsService } from '../../src/products/products.service';
import { StockService } from '../../src/stock/stock.service';
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
 * ENTEGRASYON — İPTAL DEFTERİ (`order_lines.canceled_units`) ile İADE'nin UZLAŞTIRILMASI.
 *
 * NEDEN BU DOSYA VAR (denetim C1/C3/R1):
 *   · `reconcileOrder` (mağaza re-push'u) qty düşerken defterden AYNI miktarı düşüyor
 *     (çift sayım önleme) ama `syncRefunds` (WooCommerce kısmi iadesi) `qty = netQty` yazıp
 *     deftere HİÇ dokunmuyordu → aynı iptal İKİ KEZ sayılıyordu.
 *   · Sonuç KALICI bozulmaydı: hedef (`qty − canceled_units`) teslim edilenden KÜÇÜK kalıyor,
 *     satır sonsuza dek 'partial' görünüyor ve değişim yolu stok VARKEN "stok yok" (409) veriyordu.
 *   · Aynı satır /pending kuyruğunda ve stok girişi önizlemesinde de "kapanmayacak eksik" olarak
 *     görünüyordu (R1: eksik birim yükleminin iki farklı tanımı).
 *
 * Testler bu üç yüzeyi (yazma / satır durumu / okuma sayacı) tek senaryoda kilitler.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let admin: AdminOrdersService;
let stock: StockService;
let site: CreatedSite;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;
const configFake = { get: () => undefined } as never;
const autocompleteQueueFake = { add: async () => ({ id: 'fake' }) } as never;

function siteRow(s: CreatedSite): Site {
  return { id: s.id, domain: s.domain } as unknown as Site;
}

/**
 * qty=3, 3 adet TESLİM EDİLMİŞ tek-kullanım atama kurar (satır fulfilled).
 * Atama id'leri döner — biri "operatör panelden iptal etti" senaryosunda kullanılır.
 */
async function seedDelivered(count: number): Promise<{
  product: CreatedProduct;
  orderId: string;
  lineId: string;
  remoteOrderId: string;
  remoteLineId: string;
  assignmentIds: string[];
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
    payloadPrefix: 'LEDGER',
  });
  const order = await createOrderWithLine(db, {
    siteId: site.id,
    productId: product.id,
    qty: count,
    tag,
    status: 'fulfilled',
  });
  const asgs = await db
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
    )
    .returning({ id: schema.assignments.id });
  await db
    .update(schema.orderLines)
    .set({ fulfilledQty: count, status: 'fulfilled' })
    .where(eq(schema.orderLines.id, order.lineId));
  return { product, ...order, assignmentIds: asgs.map((a) => a.id) };
}

async function readLine(lineId: string) {
  const [line] = await db
    .select({
      qty: schema.orderLines.qty,
      canceledUnits: schema.orderLines.canceledUnits,
      fulfilledQty: schema.orderLines.fulfilledQty,
      status: schema.orderLines.status,
    })
    .from(schema.orderLines)
    .where(eq(schema.orderLines.id, lineId))
    .limit(1);
  return line!;
}

describe('İptal defteri × iade uzlaştırması (C1/C3/R1)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    const products = new ProductsService(db as never);
    const fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    admin = new AdminOrdersService(db as never, redisFake, crypto, mailFake, fulfillment);
    stock = new StockService(
      db as never,
      crypto,
      products,
      fulfillment,
      configFake,
      autocompleteQueueFake,
    );
    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('C1: panelden iptal + mağaza iadesi AYNI birimi iki kez saymaz (hedef ≥ teslim edilen kalır)', async () => {
    const seed = await seedDelivered(3);

    // 1) Operatör panelden BİR atamayı iptal eder (kardeş 2 atama canlı kalır) →
    //    canceled_units=1, fulfilled=2, qty=3 (mağaza gerçeği DOKUNULMAZ).
    await admin.revokeAssignment(
      seed.assignmentIds[0]!,
      'kusurlu anahtar',
      'panel:it',
      true,
      undefined,
      false,
    );
    const afterCancel = await readLine(seed.lineId);
    expect(afterCancel.qty).toBe(3);
    expect(afterCancel.canceledUnits).toBe(1);
    expect(afterCancel.fulfilledQty).toBe(2);

    // 2) Müşteri mağazada 1 birim iade eder → net 2. Mağaza iadeyi KENDİ kaydına işledi →
    //    panel defterinden de aynı miktar düşülmeli (drop=1 ⇒ canceled_units 1→0).
    const res = await admin.syncRefunds(
      siteRow(site),
      seed.remoteOrderId,
      [{ remoteLineId: seed.remoteLineId, netQty: 2 }],
      'WooCommerce: kısmi iade',
    );
    expect(res.adjustedLines).toBe(1);

    const line = await readLine(seed.lineId);
    expect(line.qty).toBe(2);
    // REGRESYON GUARD: defter uzlaştırılmazsa 1 kalır → hedef 1 < fulfilled 2 (imkânsız durum).
    expect(line.canceledUnits).toBe(0);
    expect(line.fulfilledQty).toBe(2);
    // C3: durum HEDEFTEN türer → 2/2 = fulfilled ('partial'de kalmaz).
    expect(line.status).toBe('fulfilled');

    // Hedef (qty − canceled_units) teslim edilenden KÜÇÜK OLMAMALI — bu bozulursa değişim
    // yolu ("Kalanları Ata"/replace) satırı kalıcı olarak "stok yok" ile reddeder.
    expect(line.qty - (line.canceledUnits ?? 0)).toBeGreaterThanOrEqual(line.fulfilledQty);
  });

  it('C1: mağaza iadesi defterden FAZLASINI düşmez (drop kadar; kalan iptal korunur)', async () => {
    const seed = await seedDelivered(3);

    // İki atamayı panelden iptal et → canceled_units=2, fulfilled=1, qty=3.
    await admin.revokeAssignment(seed.assignmentIds[0]!, 'kusurlu', 'panel:it', true, undefined, false);
    await admin.revokeAssignment(seed.assignmentIds[1]!, 'kusurlu', 'panel:it', true, undefined, false);
    const mid = await readLine(seed.lineId);
    expect(mid.canceledUnits).toBe(2);
    expect(mid.fulfilledQty).toBe(1);

    // Mağazada YALNIZ 1 birim iade edildi (net 2) → drop=1 ⇒ defter 2→1 (hepsi silinmez).
    await admin.syncRefunds(
      siteRow(site),
      seed.remoteOrderId,
      [{ remoteLineId: seed.remoteLineId, netQty: 2 }],
      'WooCommerce: kısmi iade',
    );
    const line = await readLine(seed.lineId);
    expect(line.qty).toBe(2);
    expect(line.canceledUnits).toBe(1); // 2 − drop(1)
    expect(line.fulfilledQty).toBe(1);
    // Hedef = 2 − 1 = 1 = fulfilled → satır kapandı.
    expect(line.status).toBe('fulfilled');
  });

  it('R1: /pending özeti ve stok önizlemesi iptal edilmiş birimi "bekleyen iş" saymaz', async () => {
    // qty=3, 1 teslim, 1 atama iptal edilmiş → hedef 2, kalan 1 (ham qty−fulfilled 2 derdi).
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'partial-auto',
    });
    const [assignedItem] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      status: 'assigned',
      payloadPrefix: 'PENDPREV',
    });
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 3,
      tag,
      status: 'partial',
    });
    await db.insert(schema.assignments).values({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: assignedItem!,
      units: 1,
      status: 'active',
      deliveredAt: new Date(),
    });
    await db
      .update(schema.orderLines)
      .set({ fulfilledQty: 1, canceledUnits: 1, status: 'partial' })
      .where(eq(schema.orderLines.id, order.lineId));

    // (a) Stok önizlemesi: bekleyen birim 2 DEĞİL 1 olmalı (aksi halde onay modali
    //     "2 bekleyen birimi teslim eder" der ama autoComplete yalnız 1 doldurur).
    const preview = await stock.preview(product.id, 5);
    expect(preview.pendingUnits).toBe(1);

    // (b) /pending kuyruğu ürün özeti: aynı satır için missing=1.
    const pending = await admin.pending();
    const row = pending.items.find((o) => o.id === order.orderId);
    expect(row).toBeDefined();
    const summary = (row!.productSummary ?? []).find((p) => p.productId === product.id);
    expect(summary?.missing).toBe(1);

    // R5: zarf şekli — sessiz kırpma yasak, `truncated` bayrağı taşınır.
    expect(Array.isArray(pending.items)).toBe(true);
    expect(typeof pending.truncated).toBe('boolean');
  });
});
