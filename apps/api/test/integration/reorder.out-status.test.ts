import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { ReorderService } from '../../src/reports/reorder.service';
import { SlaService } from '../../src/reports/sla.service';
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
 * ENTEGRASYON — iki rapor bulgusunun REGRESYON kilidi.
 *
 *  R8 (reorder) — "stok bitti" (`out`) statüsü YALNIZ `leadDays != null` dalında
 *      hesaplanıyordu. Yani satışı SÜREN ama kapasitesi 0'a düşmüş bir ürün, tedarikçisinin
 *      kapanmış bir satın alma emri yoksa `unknown_lead` kalıyor ve ekranın EN ACİL kutusu
 *      ("Stok bitti") gerçekte tükenmiş ürünler varken 0 gösteriyordu — sayaç yalan söylüyordu.
 *
 *  R11 (sla) — `order_wait` CTE'si `line_delivery` ile INNER JOIN yaptığı için ölçülebilir
 *      satırı HİÇ olmayan sipariş (satırsız / tüm satırları iptal ya da bonus) ne `measured`'a
 *      ne `stillOpen`'a giriyordu; eleme SATIR sayısıyla raporlanıyordu ama SİPARİŞ olarak
 *      değil → "dün 40 sipariş vardı, raporda 37 var" farkı açıklanamıyordu.
 *
 * İZOLASYON: her iki rapor da GLOBAL agregasyon yapar → doğrulamalar bu dosyanın kendi
 * ürünü/sitesi üzerinden yapılır; genel sayaçlar yalnız gevşek (>=) kontrol edilir.
 */

const tag = randomUUID().slice(0, 8);
const DAY_MS = 86_400_000;

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let reorder: ReorderService;
let sla: SlaService;
let site: CreatedSite;

/**
 * Pencere İÇİNDE satış geçmişi üretir (atamalar 1 gün önce). Satılan kalemler `assigned`
 * durumundadır → eldeki atanabilir stoğa SAYILMAZ.
 */
async function seedSales(productId: string, count: number): Promise<void> {
  const items = await insertLicenseItems(db, crypto, {
    productId,
    count,
    tag,
    status: 'assigned',
  });
  const order = await createOrderWithLine(db, {
    siteId: site.id,
    productId,
    qty: count,
    tag,
    status: 'fulfilled',
  });
  // Sipariş 40 gün önceye tarihlenir: SLA penceresine (30 gün) SIZMASIN.
  await db
    .update(schema.orders)
    .set({ createdAt: new Date(Date.now() - 40 * DAY_MS) })
    .where(eq(schema.orders.id, order.orderId));
  await db
    .update(schema.orderLines)
    .set({ fulfilledQty: count, status: 'fulfilled' })
    .where(eq(schema.orderLines.id, order.lineId));
  await db.insert(schema.assignments).values(
    items.map((licenseItemId) => ({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId,
      units: 1,
      status: 'active' as const,
      deliveredAt: new Date(Date.now() - DAY_MS),
      createdAt: new Date(Date.now() - DAY_MS),
    })),
  );
}

describe('Raporlar — tükenen ürün statüsü (R8) + ölçülemeyen sipariş sayacı (R11)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    reorder = new ReorderService(db as never);
    sla = new SlaService(db as never);
    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('R8: tedarik süresi BİLİNMESE de stoğu biten ürün "out" sayılır (öneri yine üretilmez)', async () => {
    const product = await createProduct(db, { tag });
    // Satış var, ama elde HİÇ atanabilir kapasite yok; parti/satın alma emri de yok
    // → tedarik süresi bilinmiyor.
    await seedSales(product.id, 6);

    const report = await reorder.report();
    const row = report.rows.find((r) => r.productId === product.id);
    expect(row).toBeDefined();

    expect(row!.available).toBe(0);
    expect(row!.leadDays).toBeNull();
    // Düzeltmeden ÖNCE burası 'unknown_lead' idi → ürün `counts.out`'ta HİÇ görünmüyordu.
    expect(row!.status).toBe('out');
    expect(report.counts.out).toBeGreaterThanOrEqual(1);

    // Aciliyet bildirilir ama MİKTAR uydurulmaz: öneri hâlâ null (arayüz '—' basar).
    expect(row!.reorderPointUnits).toBeNull();
    expect(row!.suggestedUnits).toBeNull();
    expect(row!.suggestedKeys).toBeNull();
  });

  it('R8: stoğu OLAN ve tedarik süresi bilinmeyen ürün hâlâ "unknown_lead" kalır', async () => {
    const product = await createProduct(db, { tag });
    await seedSales(product.id, 6);
    // Elde 5 atanabilir kalem → tükenmiş DEĞİL.
    await insertLicenseItems(db, crypto, { productId: product.id, count: 5, tag });

    const report = await reorder.report();
    const row = report.rows.find((r) => r.productId === product.id);
    expect(row).toBeDefined();
    expect(row!.available).toBe(5);
    expect(row!.leadDays).toBeNull();
    // `out` yalnız kapasite 0 iken kazanır; "bilgi eksik" durumu maskelenmez.
    expect(row!.status).toBe('unknown_lead');
  });

  it('R2: hiç satışı olmayan ürün listeye girmez ve "satışsız" sayacında raporlanır', async () => {
    const silent = await createProduct(db, { tag });
    await insertLicenseItems(db, crypto, { productId: silent.id, count: 2, tag });

    const report = await reorder.report();
    // Tükenme tarihi türetilemez (0'a bölme) → satır listeye girmez…
    expect(report.rows.find((r) => r.productId === silent.id)).toBeUndefined();
    // …ama sessizce yok sayılmaz. (Sayaç artık ana listeyle AYNI CTE'den türüyor.)
    expect(report.excluded.noSalesProducts).toBeGreaterThanOrEqual(1);
  });

  it('R11: ölçülebilir satırı kalmayan sipariş SLA raporunda sayıyla görünür', async () => {
    const product = await createProduct(db, { tag });
    // Pencere İÇİNDE bir sipariş; tek satırı iptal edilmiş → ne ölçülebilir ne de "açık".
    const canceled = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
      status: 'revoked',
    });
    await db
      .update(schema.orders)
      .set({ createdAt: new Date(Date.now() - 3 * 3_600_000) })
      .where(eq(schema.orders.id, canceled.orderId));
    await db
      .update(schema.orderLines)
      .set({ canceled: true })
      .where(eq(schema.orderLines.id, canceled.lineId));

    const report = await sla.report(30);
    // Sipariş hiçbir ÖLÇÜM kovasına girmiyor (satır çıksa bile measured 0 olmalı)…
    const siteRow = report.bySite.find((r) => r.id === site.id);
    expect(siteRow?.measured ?? 0).toBe(0);
    expect(siteRow?.stillOpen ?? 0).toBe(0);
    // …ama artık SESSİZ değil (düzeltmeden önce bu sayaç hiç yoktu).
    expect(report.excluded.ordersWithoutMeasurableLines).toBeGreaterThanOrEqual(1);
  });
});
