import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExpiryService } from '../../src/maintenance/expiry.service';
import { ReconcileService } from '../../src/maintenance/reconcile.service';
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
 * ENTEGRASYON — mutabakat/tutarlılık denetçisi (ReconcileService) + süre-bitişi motoru
 * (ExpiryService), gerçek PostgreSQL'e karşı.
 *
 * Nest ayağa KALDIRILMAZ: her iki servis elle new'lenir. İkisi de reconcile()/sweepExpired()
 * içinde YALNIZ this.db kullanır (BullMQ Queue yalnız onModuleInit'te; çağrılmıyor → stub).
 *
 * KAPSAM/İZOLASYON NOTU: reconcile() ve sweepExpired() TÜM tabloyu tarar (tag'e göre
 * daraltılmaz). Bu yüzden testler global `violations.length`/dönen sayaç üzerinden DEĞİL,
 * yalnız BU koşunun seed ettiği kayıt id'leri üzerinden doğrular (başka verinin varlığı
 * sonucu etkilemez). Her senaryo kendi tag'iyle seed eder; afterAll yalnız kendi eklediklerini
 * siler (cleanupByTag: assignments → orders(cascade→lines) → license_items → products → sites).
 */

const { db, end } = makeDb();
const crypto = makeCrypto();

// Her iki servis de sweep/reconcile'da Queue'ya dokunmaz (yalnız onModuleInit) — güvenli stub.
const reconcileSvc = new ReconcileService(db as never, {} as never);
const expirySvc = new ExpiryService(db as never, {} as never);

const tag = randomUUID().slice(0, 8);

// Tek postgres bağlantısı iki describe boyunca paylaşılır. end() dosya-kapsamı (root)
// afterAll'da çağrılır: Vitest'te root afterAll TÜM describe'lardan SONRA koşar — describe
// içinden çağrılsaydı, 1. describe'ın afterAll'ı 2. describe'ın testlerinden ÖNCE bağlantıyı
// kapatırdı. Her describe kendi tag'ini afterAll'da (bağlantı hâlâ açıkken) temizler.
afterAll(async () => {
  await end();
});

/** Verilen kalem için bir atama ekler (id döner). status/units/validUntil serbest. */
async function insertAssignment(opts: {
  orderId: string;
  lineId: string;
  licenseItemId: string;
  status?: (typeof schema.assignments.$inferInsert)['status'];
  units?: number;
  validUntil?: Date | null;
}): Promise<string> {
  const [row] = await db
    .insert(schema.assignments)
    .values({
      orderId: opts.orderId,
      lineId: opts.lineId,
      licenseItemId: opts.licenseItemId,
      status: opts.status ?? 'active',
      units: opts.units ?? 1,
      validUntil: opts.validUntil ?? null,
    })
    .returning({ id: schema.assignments.id });
  return row!.id;
}

/** Bir atamanın güncel status'unu okur (null = satır yok). */
async function assignmentStatus(db_: Db, id: string): Promise<string | undefined> {
  const rows = await db_.execute<{ status: string }>(
    sql`SELECT status FROM assignments WHERE id = ${id}`,
  );
  return (rows as unknown as Array<{ status: string }>)[0]?.status;
}

describe('ReconcileService.reconcile — tutarlılık ihlallerini tespit eder (DÜZELTMEZ)', () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL tanımlı değil — entegrasyon testleri gerçek PostgreSQL gerektirir.');
    }
  });

  afterAll(async () => {
    // Yalnız bu describe'ın tag'ini temizle; bağlantı (end) dosya-kapsamı afterAll'da kapanır.
    await cleanupByTag(db, tag);
  });

  it('multi_capacity: use_count > max_uses ihlali raporlanır; kapasite içi kalem raporlanmaz', async () => {
    const product = await createProduct(db, { tag, usageMode: 'multi', maxUses: 5 });

    // (a) İHLAL: max_uses=5, use_count=6 → kapasite aşımı.
    const [overId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      maxUses: 5,
      payloadPrefix: 'MULTI-OVER',
    });
    await db.update(schema.licenseItems).set({ useCount: 6 }).where(eq(schema.licenseItems.id, overId!));

    // (b) SAĞLAM: max_uses=5, use_count=5 → sınırda, ihlal değil (> katı büyük).
    const [okId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      maxUses: 5,
      payloadPrefix: 'MULTI-OK',
    });
    await db.update(schema.licenseItems).set({ useCount: 5 }).where(eq(schema.licenseItems.id, okId!));

    const report = await reconcileSvc.reconcile();

    const over = report.violations.find(
      (v) => v.check === 'multi_capacity' && v.licenseItemId === overId,
    );
    expect(over).toBeDefined();
    expect(over).toMatchObject({ check: 'multi_capacity', useCount: 6, maxUses: 5 });

    // Kapasite içindeki kalem ihlal listesinde OLMAMALI.
    expect(
      report.violations.some((v) => v.check === 'multi_capacity' && v.licenseItemId === okId),
    ).toBe(false);
  });

  it('single_occupancy: tek-kullanım kalemde >1 ayakta atama ihlali raporlanır', async () => {
    const product = await createProduct(db, { tag });
    const site = await createSite(db, crypto, { tag });
    // Tek-kullanım kalem (max_uses=1 varsayılan).
    const [itemId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      status: 'assigned',
      payloadPrefix: 'SINGLE',
    });
    const order = await createOrderWithLine(db, { siteId: site.id, productId: product.id, qty: 1, tag });

    // Aynı tek-kullanım kaleme İKİ ayakta (active) atama → çifte satış imzası.
    await insertAssignment({ orderId: order.orderId, lineId: order.lineId, licenseItemId: itemId!, status: 'active' });
    await insertAssignment({ orderId: order.orderId, lineId: order.lineId, licenseItemId: itemId!, status: 'active' });

    const report = await reconcileSvc.reconcile();

    const v = report.violations.find(
      (x) => x.check === 'single_occupancy' && x.licenseItemId === itemId,
    );
    expect(v).toBeDefined();
    expect(v).toMatchObject({ check: 'single_occupancy', standingAssignments: 2 });
  });

  it('line_fulfillment: fulfilled_qty <> Σ(ayakta units) ihlali raporlanır; tutarlı satır raporlanmaz', async () => {
    const product = await createProduct(db, { tag });
    const site = await createSite(db, crypto, { tag });

    // (a) İHLAL: fulfilled_qty=2 ama hiç ayakta atama yok → Σ=0, 2<>0.
    const badOrder = await createOrderWithLine(db, { siteId: site.id, productId: product.id, qty: 2, tag });
    await db
      .update(schema.orderLines)
      .set({ fulfilledQty: 2 })
      .where(eq(schema.orderLines.id, badOrder.lineId));

    // (b) SAĞLAM: fulfilled_qty=1 ve tam olarak 1 ayakta atama (units=1) → 1<>1 değil.
    const [okItemId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      status: 'assigned',
      payloadPrefix: 'LINE-OK',
    });
    const goodOrder = await createOrderWithLine(db, { siteId: site.id, productId: product.id, qty: 1, tag });
    await db
      .update(schema.orderLines)
      .set({ fulfilledQty: 1 })
      .where(eq(schema.orderLines.id, goodOrder.lineId));
    await insertAssignment({
      orderId: goodOrder.orderId,
      lineId: goodOrder.lineId,
      licenseItemId: okItemId!,
      status: 'active',
      units: 1,
    });

    const report = await reconcileSvc.reconcile();

    const bad = report.violations.find(
      (v) => v.check === 'line_fulfillment' && v.lineId === badOrder.lineId,
    );
    expect(bad).toBeDefined();
    expect(bad).toMatchObject({ check: 'line_fulfillment', fulfilledQty: 2, standingUnits: 0 });

    // Tutarlı satır ihlal listesinde OLMAMALI.
    expect(
      report.violations.some((v) => v.check === 'line_fulfillment' && v.lineId === goodOrder.lineId),
    ).toBe(false);

    // Düzeltme YAPILMAZ (§16): ihlalli satırın fulfilled_qty'si hâlâ 2.
    const [line] = await db
      .select({ fulfilledQty: schema.orderLines.fulfilledQty })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, badOrder.lineId));
    expect(line?.fulfilledQty).toBe(2);
  });
});

describe('ExpiryService.sweepExpired — süre-bitişi motoru (§11)', () => {
  const etag = randomUUID().slice(0, 8);

  afterAll(async () => {
    // Yalnız bu describe'ın tag'ini temizle; bağlantı (end) dosya-kapsamı afterAll'da kapanır.
    await cleanupByTag(db, etag);
  });

  it("onExpiry='hide' + süresi geçmiş AKTİF atama → 'expired' yapılır", async () => {
    const product = await createProduct(db, { tag: etag, onExpiry: 'hide' });
    const site = await createSite(db, crypto, { tag: etag });
    const [itemId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag: etag,
      status: 'assigned',
      payloadPrefix: 'HIDE',
    });
    const order = await createOrderWithLine(db, { siteId: site.id, productId: product.id, qty: 1, tag: etag });
    const asgId = await insertAssignment({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: itemId!,
      status: 'active',
      validUntil: new Date(Date.now() - 60_000), // 1 dk önce doldu
    });

    await expirySvc.sweepExpired();

    expect(await assignmentStatus(db, asgId)).toBe('expired');
  });

  it("onExpiry='keep' + süresi geçmiş AKTİF atama → 'active' KALIR (gizlenmez)", async () => {
    const product = await createProduct(db, { tag: etag, onExpiry: 'keep' });
    const site = await createSite(db, crypto, { tag: etag });
    const [itemId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag: etag,
      status: 'assigned',
      payloadPrefix: 'KEEP',
    });
    const order = await createOrderWithLine(db, { siteId: site.id, productId: product.id, qty: 1, tag: etag });
    const asgId = await insertAssignment({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: itemId!,
      status: 'active',
      validUntil: new Date(Date.now() - 60_000), // süresi geçmiş ama keep
    });

    await expirySvc.sweepExpired();

    // keep politikası: süre geçse bile atama aktif kalır (§11) — getDeliveries 'expired' bayrağı verir.
    expect(await assignmentStatus(db, asgId)).toBe('active');
  });
});
