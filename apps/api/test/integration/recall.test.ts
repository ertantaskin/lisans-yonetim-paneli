import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupplyOpsService } from '../../src/supply-ops/supply-ops.service';
import * as schema from '../../src/db/schema';
import {
  cleanupByTag,
  createOrderWithLine,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — batch recall (SupplyOpsService.recallBatch).
 *
 * Nest ayağa KALDIRILMAZ: servis elle new'lenir (recallBatch YALNIZ this.db kullanır →
 * adminOrders/fulfillment bağımlılıkları çağrılmaz, stub geçilir). Her senaryo kendi
 * randomUUID().slice(0,8) tag'iyle seed eder; afterAll SADECE bu koşunun eklediklerini
 * siler (batches/stock_adjustments/audit_log elle; gerisi cleanupByTag). Global truncate YOK.
 *
 * REGRESYON [AUDIT FIX]: recallBatch, satılmış (elle değiştirme gereken) adedi AYNI tx'te
 * void'e çekilmiş kalemleri sayarak DEĞİL, AKTİF atama (EXISTS assignments.status='active')
 * üzerinden hesaplar. Eskiden N available/0 satılmış partide, void'den sonra status<>'available'
 * tüm N kalemi sayıp soldNeedingReplacement=N döndürüyordu → artık 0 dönmeli.
 */

const { db, end } = makeDb();
const crypto = makeCrypto();

// recallBatch this.db dışında bir şey çağırmaz — diğer bağımlılıklar için güvenli stub.
const svc = new SupplyOpsService(db as never, {} as never, {} as never);

const tag = randomUUID().slice(0, 8);

// afterAll'da elle temizlenecek (cleanupByTag bunlara dokunmaz) — FK: batches/stock_adjustments
// products'a restrict ile bağlı, products silinmeden önce bunlar gitmeli.
const productIds: string[] = [];
const batchIds: string[] = [];

async function insertBatch(dbc: Db, productId: string): Promise<string> {
  const [row] = await dbc
    .insert(schema.batches)
    .values({ productId, label: `it-${tag}-batch`, status: 'active', qtyReceived: 0 })
    .returning({ id: schema.batches.id });
  batchIds.push(row!.id);
  return row!.id;
}

async function setBatchId(dbc: Db, itemIds: string[], batchId: string): Promise<void> {
  await dbc
    .update(schema.licenseItems)
    .set({ batchId })
    .where(inArray(schema.licenseItems.id, itemIds));
}

describe('SupplyOpsService.recallBatch (batch recall)', () => {
  beforeAll(async () => {
    // makeDb DATABASE_URL yoksa zaten fırlatır; burada erken/anlamlı doğrula.
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL tanımlı değil — entegrasyon testleri gerçek PostgreSQL gerektirir.');
    }
  });

  afterAll(async () => {
    // 1) audit_log recall izleri (FK yok — targetId=batchId ile sil).
    if (batchIds.length > 0) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, batchIds));
    }
    // 2) stock_adjustments + batches — products'a restrict FK; cleanupByTag'ten ÖNCE.
    if (productIds.length > 0) {
      await db
        .delete(schema.stockAdjustments)
        .where(inArray(schema.stockAdjustments.productId, productIds));
      await db.delete(schema.batches).where(inArray(schema.batches.productId, productIds));
    }
    // 3) assignments/orders/license_items/products/sites — tag ile.
    await cleanupByTag(db, tag);
    await end();
  });

  it('N available + 0 satılmış → { voided: N, soldNeedingReplacement: 0 } [REGRESYON]', async () => {
    const N = 3;
    const product = await createProduct(db, { tag });
    productIds.push(product.id);

    const batchId = await insertBatch(db, product.id);
    const itemIds = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: N,
      tag,
      status: 'available',
    });
    await setBatchId(db, itemIds, batchId);

    const res = await svc.recallBatch(batchId, 'toplu geri çağırma testi', 'it-actor');

    // Eskiden bu N dönerdi (void'e çekilenler status<>'available' → yanlış sayım). Artık 0.
    expect(res.voided).toBe(N);
    expect(res.soldNeedingReplacement).toBe(0);

    // Parti gerçekten 'recalled' + tüm available kalemler 'voided'.
    const batchRows = await db.execute<{ status: string }>(
      sql`SELECT status FROM batches WHERE id = ${batchId}`,
    );
    expect((batchRows as unknown as Array<{ status: string }>)[0]?.status).toBe('recalled');

    const voidedCount = await db.execute<{ c: number }>(
      sql`SELECT count(*)::int AS c FROM license_items WHERE batch_id = ${batchId} AND status = 'voided'`,
    );
    expect(Number((voidedCount as unknown as Array<{ c: number }>)[0]?.c)).toBe(N);

    // Her void için sebepli stock_adjustments('recall') satırı.
    const adjCount = await db.execute<{ c: number }>(
      sql`SELECT count(*)::int AS c FROM stock_adjustments WHERE product_id = ${product.id} AND action = 'recall'`,
    );
    expect(Number((adjCount as unknown as Array<{ c: number }>)[0]?.c)).toBe(N);
  });

  it('1 satılmış (aktif atamalı) + M available → { voided: M, soldNeedingReplacement: 1 }', async () => {
    const M = 2;
    const product = await createProduct(db, { tag });
    productIds.push(product.id);
    const site = await createSite(db, crypto, { tag });

    const batchId = await insertBatch(db, product.id);

    // M available kalem (void edilecek).
    const availableIds = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: M,
      tag,
      status: 'available',
    });
    await setBatchId(db, availableIds, batchId);

    // 1 satılmış kalem: status 'assigned' + AKTİF atama (aynı partide).
    const [soldItemId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      status: 'assigned',
      payloadPrefix: 'SOLD',
    });
    await setBatchId(db, [soldItemId!], batchId);

    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
    });
    await db.insert(schema.assignments).values({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: soldItemId!,
      status: 'active',
    });

    const res = await svc.recallBatch(batchId, 'kısmi satılmış parti', 'it-actor');

    expect(res.voided).toBe(M);
    expect(res.soldNeedingReplacement).toBe(1);

    // Satılmış kalem void EDİLMEZ (available değildi) — 'assigned' kalır.
    const soldStatus = await db.execute<{ status: string }>(
      sql`SELECT status FROM license_items WHERE id = ${soldItemId!}`,
    );
    expect((soldStatus as unknown as Array<{ status: string }>)[0]?.status).toBe('assigned');
  });
});
