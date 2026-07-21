import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { CostsService } from '../../src/reports/costs.service';
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
 * ENTEGRASYON — CostsService.getCostReport().deliveredCogs (audit HIGH: para raporu testsizdi).
 *
 * Doğrulanan para-invaryantları (kolay bozulabilir, sessiz yanlış rakam üretir):
 *  1) Para birimi ASLA tek toplamda birleşmez — her currency AYRI satır.
 *  2) cogsCents = Σ(units × unit_cost_cents), deliveredUnits = Σ units (yalnız cost'lu atamalar).
 *  3) unit_cost_cents NULL atamalar uncoveredUnits olarak AYRI ('' currency) sayılır, cogs'a KATILMAZ.
 *
 * deliveredCogs DB düzeyinde GLOBAL agregasyondur (tag ile filtrelenemez) → testin kendi
 * satırlarını izole etmek için BENZERSİZ para birimleri kullanılır; yalnız o satırlar assert edilir.
 */

const tag = randomUUID().slice(0, 8);
const CUR1 = `T1${tag.slice(0, 4)}`; // benzersiz — başka veriyle çakışmaz
const CUR2 = `T2${tag.slice(0, 4)}`;
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let costs: CostsService;
let site: CreatedSite;

/** Tek satırlı sipariş + verilen kaleme AKTİF + teslim edilmiş atama ekler. */
async function attachDeliveredAssignment(orderId: string, lineId: string, licenseItemId: string): Promise<void> {
  await db.insert(schema.assignments).values({
    orderId,
    lineId,
    licenseItemId,
    units: 1,
    status: 'active',
    deliveredAt: new Date(),
  });
}

describe('CostsService.deliveredCogs (teslim edilen maliyet, para birimi ayrımı)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    costs = new CostsService(db as never);
    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('iki farklı para birimi AYRI satır; cogs doğru toplanır; NULL-cost uncovered AYRI sayılır', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    // 4 kalem: CUR1×2 (1000+2000), CUR2×1 (500), NULL-cost×1.
    const [i1, i2, i3, i4] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 4,
      tag,
      status: 'assigned',
    });
    await db.update(schema.licenseItems).set({ unitCostCents: 1000, costCurrency: CUR1 }).where(eq(schema.licenseItems.id, i1!));
    await db.update(schema.licenseItems).set({ unitCostCents: 2000, costCurrency: CUR1 }).where(eq(schema.licenseItems.id, i2!));
    await db.update(schema.licenseItems).set({ unitCostCents: 500, costCurrency: CUR2 }).where(eq(schema.licenseItems.id, i3!));
    // i4: unit_cost_cents NULL kalır (uncovered).

    const order = await createOrderWithLine(db, { siteId: site.id, productId: product.id, qty: 4, tag });
    for (const id of [i1!, i2!, i3!, i4!]) {
      await attachDeliveredAssignment(order.orderId, order.lineId, id);
    }

    const report = await costs.getCostReport();
    const rows = report.deliveredCogs;

    // CUR1: iki atama tek satırda toplanır (para birimi birleştirilmez → CUR2 ayrı).
    const r1 = rows.find((r) => r.currency === CUR1);
    expect(r1).toBeDefined();
    expect(r1!.cogsCents).toBe(3000);
    expect(r1!.deliveredUnits).toBe(2);
    expect(r1!.uncoveredUnits).toBe(0);

    // CUR2: ayrı satır (CUR1 ile toplanmaz).
    const r2 = rows.find((r) => r.currency === CUR2);
    expect(r2).toBeDefined();
    expect(r2!.cogsCents).toBe(500);
    expect(r2!.deliveredUnits).toBe(1);
    expect(r2!.uncoveredUnits).toBe(0);

    // NULL-cost atama '' currency satırında uncovered olarak sayılır (global satır → en az 1).
    const rEmpty = rows.find((r) => r.currency === '');
    expect(rEmpty).toBeDefined();
    expect(rEmpty!.uncoveredUnits).toBeGreaterThanOrEqual(1);
  });
});
