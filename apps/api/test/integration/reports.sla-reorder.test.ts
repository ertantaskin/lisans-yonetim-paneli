import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { SlaService } from '../../src/reports/sla.service';
import {
  ReorderService,
  REORDER_WINDOW_DAYS,
  SAFETY_DAYS,
  TARGET_COVER_DAYS,
} from '../../src/reports/reorder.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createOrderWithLine,
  createProduct,
  createSite,
  createSupplier,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  type CreatedSite,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — İKİ YENİ RAPOR (mevcut veriden türer; migration YOK).
 *
 *  1. SlaService     — teslimat süresi / bekleme (p50 · p95), anında ↔ bekleyen ayrımı ve
 *                      iptal (`canceled`) / incelemedeki (`held_for_review`) / bonus satır /
 *                      DEĞİŞİM atamalarının hesaba KATILMADIĞI.
 *  2. ReorderService — tedarik süresi BİLİNEN / BİLİNMEYEN senaryolar + yeniden sipariş
 *                      noktasının EŞİK KENARI (available == reorderPoint) + MAK birim mantığı.
 *
 * İZOLASYON: raporlar GLOBAL agregasyon yapar (tag süzgeci yok) → doğrulamalar HER ZAMAN
 * bu dosyanın kendi sitesi/ürünü üzerinden (`bySite.find` / `rows.find`) yapılır, `totals`
 * yalnız gevşek (>=) kontrol edilir. Aksi hâlde başka dosyaların artıkları testi kırardı.
 */

const tag = randomUUID().slice(0, 8);
const DAY_MS = 86_400_000;

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let sla: SlaService;
let reorder: ReorderService;

/** Siparişin panele düştüğü an — pencerenin ORTASINDA (gün sınırına takılmasın). */
const ORDER_AT = new Date(Date.now() - 3 * 3_600_000);

/**
 * SLA için tek satırlı, TAMAMEN teslim edilmiş sipariş üretir.
 * `waitSeconds`: atamanın sipariş anından kaç saniye SONRA yazıldığı.
 *   0 → anında (üretimde sipariş ve atama AYNI transaction'da yazıldığı için fark tam 0'dır).
 */
async function seedDeliveredOrder(opts: {
  siteId: string;
  productId: string;
  waitSeconds: number;
  qty?: number;
  held?: boolean;
  canceledLine?: boolean;
  /** Atamayı DEĞİŞİM kaydı gibi işaretle (assignment_history satırı yazılır). */
  assignmentStatus?: 'active' | 'replaced';
}): Promise<{ orderId: string; lineId: string }> {
  const qty = opts.qty ?? 1;
  const order = await createOrderWithLine(db, {
    siteId: opts.siteId,
    productId: opts.productId,
    qty,
    tag,
    status: 'fulfilled',
  });
  await db
    .update(schema.orders)
    .set({ createdAt: ORDER_AT, heldForReview: opts.held ?? false })
    .where(eq(schema.orders.id, order.orderId));
  await db
    .update(schema.orderLines)
    .set({ fulfilledQty: qty, status: 'fulfilled', canceled: opts.canceledLine ?? false })
    .where(eq(schema.orderLines.id, order.lineId));

  const [item] = await insertLicenseItems(db, crypto, {
    productId: opts.productId,
    count: 1,
    tag,
    status: 'assigned',
  });
  await db.insert(schema.assignments).values({
    orderId: order.orderId,
    lineId: order.lineId,
    licenseItemId: item!,
    units: qty,
    status: opts.assignmentStatus ?? 'active',
    deliveredAt: new Date(ORDER_AT.getTime() + opts.waitSeconds * 1000),
    createdAt: new Date(ORDER_AT.getTime() + opts.waitSeconds * 1000),
  });
  return order;
}

/**
 * Yeniden-sipariş raporu için SATIŞ geçmişi: `unitsPerAssignment` uzunluğunda atama üretir.
 * Sipariş 40 gün önceye tarihlenir (SLA penceresine SIZMASIN); atamalar 1 gün öncesine
 * (velocity penceresinin İÇİ). Satılan kalemler `assigned` → eldeki stoğa SAYILMAZ.
 */
async function seedSales(opts: {
  siteId: string;
  productId: string;
  unitsPerAssignment: number[];
  maxUses?: number;
}): Promise<void> {
  const total = opts.unitsPerAssignment.reduce((s, u) => s + u, 0);
  const items = await insertLicenseItems(db, crypto, {
    productId: opts.productId,
    count: opts.unitsPerAssignment.length,
    tag,
    status: 'assigned',
    maxUses: opts.maxUses ?? 1,
  });
  const order = await createOrderWithLine(db, {
    siteId: opts.siteId,
    productId: opts.productId,
    qty: total,
    tag,
    status: 'fulfilled',
  });
  await db
    .update(schema.orders)
    .set({ createdAt: new Date(Date.now() - 40 * DAY_MS) })
    .where(eq(schema.orders.id, order.orderId));
  await db
    .update(schema.orderLines)
    .set({ fulfilledQty: total, status: 'fulfilled' })
    .where(eq(schema.orderLines.id, order.lineId));
  await db.insert(schema.assignments).values(
    opts.unitsPerAssignment.map((units, i) => ({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: items[i]!,
      units,
      status: 'active' as const,
      deliveredAt: new Date(Date.now() - DAY_MS),
      createdAt: new Date(Date.now() - DAY_MS),
    })),
  );
}

/** Kapanmış (teslim alınmış) satın alma emri → tedarikçinin ortalama teslim süresi buradan. */
async function seedClosedPo(opts: {
  supplierId: string;
  productId: string;
  orderedDaysAgo: number;
  receivedDaysAgo: number;
}): Promise<void> {
  await db.insert(schema.purchaseOrders).values({
    supplierId: opts.supplierId,
    productId: opts.productId,
    status: 'received',
    qtyOrdered: 5,
    qtyReceived: 5,
    orderedAt: new Date(Date.now() - opts.orderedDaysAgo * DAY_MS),
    receivedAt: new Date(Date.now() - opts.receivedDaysAgo * DAY_MS),
  });
}

/** Ürünün GÜNCEL tedarikçisi partiden çözülür (rapor CostsService/karne zinciriyle aynı). */
async function seedBatch(supplierId: string, productId: string): Promise<void> {
  await db.insert(schema.batches).values({
    supplierId,
    productId,
    label: `${tag}-parti`,
    qtyReceived: 5,
    receivedAt: new Date(Date.now() - 5 * DAY_MS),
  });
}

describe('Raporlar — teslimat süresi (SLA) + yeniden-sipariş önerisi', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    sla = new SlaService(db as never);
    reorder = new ReorderService(db as never);
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  // ── SLA ────────────────────────────────────────────────────────────────────

  it('p50/p95 BİLİNEN zaman damgalarından doğru hesaplanır; anında ↔ bekleyen AYRILIR', async () => {
    const site: CreatedSite = await createSite(db, crypto, { tag });
    const product = await createProduct(db, { tag });

    // 10 anında (fark = 0) + 10 bekleyen (60, 120, … 600 sn).
    for (let i = 0; i < 10; i += 1) {
      await seedDeliveredOrder({ siteId: site.id, productId: product.id, waitSeconds: 0 });
    }
    const waits = [60, 120, 180, 240, 300, 360, 420, 480, 540, 600];
    for (const w of waits) {
      await seedDeliveredOrder({ siteId: site.id, productId: product.id, waitSeconds: w });
    }

    const report = await sla.report(30);
    const row = report.bySite.find((r) => r.id === site.id);
    expect(row).toBeDefined();

    expect(row!.measured).toBe(20);
    expect(row!.instant).toBe(10);
    expect(row!.waited).toBe(10);
    expect(row!.stillOpen).toBe(0);

    // percentile_cont (SÜREKLİ interpolasyon), yalnız BEKLEYENLER üzerinde:
    //   p50 → index 0.5×(10−1)=4.5 → 300 ile 360 arası = 330
    //   p95 → index 0.95×9=8.55    → 540 + 0.55×60     = 573
    expect(row!.waitedStats.p50Seconds).toBeCloseTo(330, 1);
    expect(row!.waitedStats.p95Seconds).toBeCloseTo(573, 1);
    expect(row!.waitedStats.maxSeconds).toBeCloseTo(600, 1);
    // Ortalama tek başına 330 der ama gerçekte siparişlerin yarısı anındaydı.
    expect(row!.waitedStats.avgSeconds).toBeCloseTo(330, 1);

    // Anındalar DAHİL edilince medyan çöker (bu yüzden iki kova ayrı raporlanır):
    //   sıralı 20 değer → index 9.5 → 0 ile 60 arası = 30
    expect(row!.overallStats.p50Seconds).toBeCloseTo(30, 1);

    // Ürün kırılımı SATIR bazlıdır; tek satırlı siparişlerde sipariş kırılımıyla örtüşür.
    const prow = report.byProduct.find((r) => r.id === product.id);
    expect(prow).toBeDefined();
    expect(prow!.measured).toBe(20);
    expect(prow!.waitedStats.p95Seconds).toBeCloseTo(573, 1);

    expect(report.totals.measured).toBeGreaterThanOrEqual(20);
    expect(report.windowDays).toBe(30);
  });

  it('iptal (canceled) satır, incelemedeki (held) sipariş ve BONUS satır hesaba KATILMAZ', async () => {
    const site = await createSite(db, crypto, { tag });
    const product = await createProduct(db, { tag });

    // (a) İncelemedeki sipariş — 10 saatlik "bekleme" ile; ölçüme girerse p95 patlardı.
    await seedDeliveredOrder({
      siteId: site.id,
      productId: product.id,
      waitSeconds: 36_000,
      held: true,
    });
    // (b) Tamamı iptal edilmiş satır — yine 10 saatlik damga.
    await seedDeliveredOrder({
      siteId: site.id,
      productId: product.id,
      waitSeconds: 36_000,
      canceledLine: true,
    });
    // (c) Normal, anında teslim edilmiş sipariş.
    await seedDeliveredOrder({ siteId: site.id, productId: product.id, waitSeconds: 0 });
    // (d) Anında teslim + SONRADAN eklenen bonus satır (mağazadan gelen talep DEĞİL).
    const bonusOrder = await seedDeliveredOrder({
      siteId: site.id,
      productId: product.id,
      waitSeconds: 0,
    });
    const [bonusLine] = await db
      .insert(schema.orderLines)
      .values({
        orderId: bonusOrder.orderId,
        productId: product.id,
        remoteLineId: `bonus:${randomUUID()}`,
        qty: 1,
        fulfilledQty: 1,
        status: 'fulfilled',
      })
      .returning({ id: schema.orderLines.id });
    const [bonusItem] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      status: 'assigned',
    });
    await db.insert(schema.assignments).values({
      orderId: bonusOrder.orderId,
      lineId: bonusLine!.id,
      licenseItemId: bonusItem!,
      units: 1,
      status: 'active',
      deliveredAt: new Date(ORDER_AT.getTime() + 36_000_000),
      createdAt: new Date(ORDER_AT.getTime() + 36_000_000),
    });

    const report = await sla.report(30);
    const row = report.bySite.find((r) => r.id === site.id);
    expect(row).toBeDefined();

    // YALNIZ (c) ve (d) ölçülür ve İKİSİ DE anındadır — bonus satırın 10 saati sızmadı.
    expect(row!.measured).toBe(2);
    expect(row!.instant).toBe(2);
    expect(row!.waited).toBe(0);
    expect(row!.waitedStats.p50Seconds).toBeNull();
    expect(row!.waitedStats.p95Seconds).toBeNull();
    expect(row!.overallStats.maxSeconds).toBeCloseTo(0, 1);

    // Eleme SESSİZ değil — sayıyla raporlanır.
    expect(report.excluded.heldOrders).toBeGreaterThanOrEqual(1);
    expect(report.excluded.canceledLines).toBeGreaterThanOrEqual(1);
    expect(report.excluded.bonusLines).toBeGreaterThanOrEqual(1);
  });

  it('DEĞİŞİMLE verilen taze anahtar süreye eklenmez (ilk teslimat esas alınır)', async () => {
    const site = await createSite(db, crypto, { tag });
    const product = await createProduct(db, { tag });

    // İlk teslimat 120 sn sonra yapıldı; sonra anahtar değiştirildi (2 gün sonra).
    const order = await seedDeliveredOrder({
      siteId: site.id,
      productId: product.id,
      waitSeconds: 120,
      assignmentStatus: 'replaced',
    });
    const [freshItem] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      status: 'assigned',
    });
    const [fresh] = await db
      .insert(schema.assignments)
      .values({
        orderId: order.orderId,
        lineId: order.lineId,
        licenseItemId: freshItem!,
        units: 1,
        status: 'active',
        deliveredAt: new Date(ORDER_AT.getTime() + 2 * DAY_MS),
        createdAt: new Date(ORDER_AT.getTime() + 2 * DAY_MS),
      })
      .returning({ id: schema.assignments.id });
    // Soyağacı kaydı = "bu atama bir DEĞİŞİMİN sonucudur" işareti.
    await db.insert(schema.assignmentHistory).values({
      assignmentId: fresh!.id,
      oldLicenseItemId: null,
      newLicenseItemId: freshItem!,
      reason: 'kusurlu anahtar',
      actor: `it-${tag}`,
    });

    const report = await sla.report(30);
    const row = report.bySite.find((r) => r.id === site.id);
    expect(row).toBeDefined();
    expect(row!.measured).toBe(1);
    expect(row!.waited).toBe(1);
    // 2 GÜNLÜK değişim damgası değil, 120 sn'lik İLK teslimat.
    expect(row!.waitedStats.p50Seconds).toBeCloseTo(120, 1);
    expect(row!.waitedStats.maxSeconds).toBeCloseTo(120, 1);
  });

  it('days parametresi sınırlara oturur (geçersiz değer ekranı boşaltmaz)', () => {
    expect(SlaService.normalizeDays('abc')).toBe(SlaService.DEFAULT_DAYS);
    expect(SlaService.normalizeDays(undefined)).toBe(SlaService.DEFAULT_DAYS);
    expect(SlaService.normalizeDays(0)).toBe(SlaService.MIN_DAYS);
    expect(SlaService.normalizeDays(-5)).toBe(SlaService.MIN_DAYS);
    expect(SlaService.normalizeDays(9999)).toBe(SlaService.MAX_DAYS);
    expect(SlaService.normalizeDays('7')).toBe(7);
  });

  // ── Yeniden-sipariş önerisi ────────────────────────────────────────────────

  it('tedarik süresi BİLİNİYOR → yeniden sipariş noktası + önerilen adet hesaplanır', async () => {
    const site = await createSite(db, crypto, { tag });
    const supplier = await createSupplier(db, { tag });
    // lowStockThreshold=1 bilerek DÜŞÜK: sabit eşik SUSARKEN bu raporun sipariş demesi
    // ("alarm çaldığında geç kalmışsın") raporun var oluş sebebidir.
    const product = await createProduct(db, { tag, lowStockThreshold: 1 });

    await seedSales({ siteId: site.id, productId: product.id, unitsPerAssignment: Array(10).fill(1) });
    await insertLicenseItems(db, crypto, { productId: product.id, count: 3, tag });
    await seedBatch(supplier.id, product.id);
    await seedClosedPo({
      supplierId: supplier.id,
      productId: product.id,
      orderedDaysAgo: 20,
      receivedDaysAgo: 10,
    });

    const report = await reorder.report();
    expect(report.params).toEqual({
      windowDays: REORDER_WINDOW_DAYS,
      safetyDays: SAFETY_DAYS,
      coverDays: TARGET_COVER_DAYS,
    });

    const row = report.rows.find((r) => r.productId === product.id);
    expect(row).toBeDefined();
    expect(row!.supplierId).toBe(supplier.id);
    expect(row!.leadDays).toBeCloseTo(10, 1);
    expect(row!.available).toBe(3);
    expect(row!.soldUnits).toBe(10);
    // 10 / 30 = 0,3333 birim/gün → 3 / 0,3333 = 9 gün kaldı.
    expect(row!.daysRemaining).toBeCloseTo(9, 1);
    expect(row!.stockoutOn).not.toBeNull();
    // ceil(0,3333 × (10 + 7)) = ceil(5,67) = 6 → eldeki 3, noktanın ALTINDA.
    expect(row!.reorderPointUnits).toBe(6);
    expect(row!.status).toBe('order_now');
    // ceil(0,3333 × (10 + 7 + 30)) = 16 → 16 − 3 elde − 0 yolda = 13
    expect(row!.suggestedUnits).toBe(13);
    expect(row!.suggestedKeys).toBe(13);
    expect(row!.unitsPerKey).toBe(1);
    // SABİT eşik (1) susuyor ama türetilmiş eşik sipariş diyor — raporun asıl noktası.
    expect(row!.belowFixedThreshold).toBe(false);
    expect(report.counts.order_now).toBeGreaterThanOrEqual(1);
  });

  it('tedarik süresi BİLİNMİYOR → öneri ÜRETİLMEZ (varsayılan uydurulmaz)', async () => {
    const site = await createSite(db, crypto, { tag });
    const product = await createProduct(db, { tag });

    await seedSales({ siteId: site.id, productId: product.id, unitsPerAssignment: Array(10).fill(1) });
    await insertLicenseItems(db, crypto, { productId: product.id, count: 3, tag });
    // Parti/satın alma emri YOK → tedarikçi de ortalama teslim süresi de bilinmiyor.

    const report = await reorder.report();
    const row = report.rows.find((r) => r.productId === product.id);
    expect(row).toBeDefined();
    expect(row!.supplierId).toBeNull();
    expect(row!.leadDays).toBeNull();
    expect(row!.status).toBe('unknown_lead');
    expect(row!.reorderPointUnits).toBeNull();
    expect(row!.suggestedUnits).toBeNull();
    expect(row!.suggestedKeys).toBeNull();
    // Bilinmeyen tedarik süresi tükenme tahminini ENGELLEMEZ (elde olan bilgi gösterilir).
    expect(row!.daysRemaining).toBeCloseTo(9, 1);
    expect(report.counts.unknown_lead).toBeGreaterThanOrEqual(1);
  });

  it('EŞİK KENARI: eldeki stok yeniden sipariş noktasına EŞİTSE sipariş denir, bir fazlası takipte', async () => {
    const site = await createSite(db, crypto, { tag });
    const supplier = await createSupplier(db, { tag });
    const onPoint = await createProduct(db, { tag });
    const abovePoint = await createProduct(db, { tag });

    // İki ürün de 15 birim/30 gün = 0,5 birim/gün; tedarik süresi 3 gün.
    // → yeniden sipariş noktası = ceil(0,5 × (3 + 7)) = 5
    for (const p of [onPoint, abovePoint]) {
      await seedSales({ siteId: site.id, productId: p.id, unitsPerAssignment: Array(15).fill(1) });
      await seedBatch(supplier.id, p.id);
    }
    await seedClosedPo({
      supplierId: supplier.id,
      productId: onPoint.id,
      orderedDaysAgo: 13,
      receivedDaysAgo: 10,
    });
    await insertLicenseItems(db, crypto, { productId: onPoint.id, count: 5, tag });
    await insertLicenseItems(db, crypto, { productId: abovePoint.id, count: 6, tag });

    const report = await reorder.report();
    const on = report.rows.find((r) => r.productId === onPoint.id);
    const above = report.rows.find((r) => r.productId === abovePoint.id);
    expect(on).toBeDefined();
    expect(above).toBeDefined();

    expect(on!.leadDays).toBeCloseTo(3, 1);
    expect(on!.reorderPointUnits).toBe(5);
    expect(on!.available).toBe(5);
    // KENAR DÂHİL: eşitlik "hâlâ yeterli" değil, "tam sınırdasın" demektir.
    expect(on!.status).toBe('order_now');

    expect(above!.reorderPointUnits).toBe(5);
    expect(above!.available).toBe(6);
    // 6 > 5 → acil değil; ama 12 gün kaldı, hedef pencere (3+7+30=40) içinde → takipte.
    expect(above!.status).toBe('watch');
    expect(above!.daysRemaining).toBeCloseTo(12, 1);
  });

  it('MAK/çok kullanımlı üründe BİRİM ↔ ADET çevrimi doğru (açık emir de birime çevrilir)', async () => {
    const site = await createSite(db, crypto, { tag });
    const supplier = await createSupplier(db, { tag });
    const product = await createProduct(db, { tag, usageMode: 'multi', maxUses: 100 });

    // 3 anahtar × 100 kullanım = 300 birim / 30 gün = 10 birim/gün.
    await seedSales({
      siteId: site.id,
      productId: product.id,
      unitsPerAssignment: [100, 100, 100],
      maxUses: 100,
    });
    // Elde 2 anahtar × 100 = 200 BİRİM (2 "adet" değil — sayım kapasite üzerinden).
    await insertLicenseItems(db, crypto, { productId: product.id, count: 2, tag, maxUses: 100 });
    await seedBatch(supplier.id, product.id);
    await seedClosedPo({
      supplierId: supplier.id,
      productId: product.id,
      orderedDaysAgo: 12,
      receivedDaysAgo: 7,
    });
    // Açık emir: 1 ADET sipariş edildi, teslim alınmadı → 1 × 100 = 100 BİRİM yolda.
    await db.insert(schema.purchaseOrders).values({
      supplierId: supplier.id,
      productId: product.id,
      status: 'ordered',
      qtyOrdered: 1,
      qtyReceived: 0,
      orderedAt: new Date(Date.now() - 2 * DAY_MS),
    });

    const report = await reorder.report();
    const row = report.rows.find((r) => r.productId === product.id);
    expect(row).toBeDefined();

    expect(row!.usageMode).toBe('multi');
    expect(row!.unitsPerKey).toBe(100);
    expect(row!.available).toBe(200);
    expect(row!.soldUnits).toBe(300);
    expect(row!.dailyRate).toBeCloseTo(10, 5);
    expect(row!.daysRemaining).toBeCloseTo(20, 1);
    expect(row!.leadDays).toBeCloseTo(5, 1);
    expect(row!.openOrderKeys).toBe(1);
    expect(row!.openOrderUnits).toBe(100);
    // ceil(10 × (5 + 7)) = 120 → elde 200 > 120, ama 20 gün < 42 gün hedef → takipte.
    expect(row!.reorderPointUnits).toBe(120);
    expect(row!.status).toBe('watch');
    // ceil(10 × (5 + 7 + 30)) = 420 → 420 − 200 elde − 100 yolda = 120 birim = 2 ADET.
    expect(row!.suggestedUnits).toBe(120);
    expect(row!.suggestedKeys).toBe(2);
  });
});
