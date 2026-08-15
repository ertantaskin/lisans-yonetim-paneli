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
const CUR3 = `T3${tag.slice(0, 4)}`; // yalnız zaman penceresi testinde
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let costs: CostsService;
let site: CreatedSite;

/**
 * Tek satırlı sipariş + verilen kaleme AKTİF + teslim edilmiş atama ekler.
 * `deliveredAt` verilmezse "şimdi" (zaman penceresi testleri geçmiş bir an geçirir).
 */
async function attachDeliveredAssignment(
  orderId: string,
  lineId: string,
  licenseItemId: string,
  deliveredAt: Date = new Date(),
): Promise<void> {
  await db.insert(schema.assignments).values({
    orderId,
    lineId,
    licenseItemId,
    units: 1,
    status: 'active',
    deliveredAt,
  });
}

/** "N ay önce" (gün ortası — yerel gün sınırı kaymalarından etkilenmesin). */
function monthsAgo(months: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setMonth(d.getMonth() - months);
  return d;
}

/** Date → `YYYY-MM-DD` (yerel) — API'nin gün girdisi biçimi. */
function dayStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/*
 * Bağlantı/temizlik DOSYA düzeyinde: aşağıda İKİ describe var ve hook'lar ilk describe'ın
 * içinde kalsaydı `afterAll` (end()) ikinci describe koşmadan bağlantıyı kapatırdı.
 */
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

describe('CostsService.deliveredCogs (teslim edilen maliyet, para birimi ayrımı)', () => {
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

/**
 * ENTEGRASYON — zaman penceresi (denetim bulgusu O7).
 *
 * Neden entegrasyon şart: pencere fragmanı HAM `sql` şablonuyla kuruluyor. Oraya bir `Date`
 * NESNESİ konsa postgres.js bind aşamasında ERR_INVALID_ARG_TYPE atar ve uç HER ZAMAN 500
 * döner — `tsc` ve `next build` bunu YAKALAMAZ (bu projede `/audit` tarih süzgecinde yaşandı).
 * Bu testler ISO dize + `::timestamptz` desenini kilitler.
 *
 * `getCostReport()` ALTI sorguyu birden koşar → bySupplier/byProduct/byMonth/wastage
 * pencerelerinde bir SQL/bind hatası olsaydı bu testler de patlardı (kapsam bedava gelmiyor,
 * ama sessiz kalmıyor da).
 */
describe('CostsService zaman penceresi (varsayılan / tüm zamanlar / açık aralık)', () => {
  let oldItem: string;
  let freshItem: string;

  beforeAll(async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const [a, b] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 2,
      tag,
      status: 'assigned',
      payloadPrefix: 'WIN',
    });
    oldItem = a!;
    freshItem = b!;
    // Aynı BENZERSİZ para birimi → iki satır tek kovada toplanır, başka veriyle karışmaz.
    await db
      .update(schema.licenseItems)
      .set({ unitCostCents: 700, costCurrency: CUR3 })
      .where(eq(schema.licenseItems.id, oldItem));
    await db
      .update(schema.licenseItems)
      .set({ unitCostCents: 300, costCurrency: CUR3 })
      .where(eq(schema.licenseItems.id, freshItem));

    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 2,
      tag,
    });
    // 18 ay önce teslim → varsayılan 12 aylık pencerenin DIŞINDA.
    await attachDeliveredAssignment(order.orderId, order.lineId, oldItem, monthsAgo(18));
    await attachDeliveredAssignment(order.orderId, order.lineId, freshItem);
  });

  const cur3 = (rows: Array<{ currency: string; cogsCents: number; deliveredUnits: number }>) =>
    rows.find((r) => r.currency === CUR3);

  it('parametresiz çağrı VARSAYILAN pencereyi (son 12 ay) uygular ve bunu window ile bildirir', async () => {
    const report = await costs.getCostReport();

    // Sessiz kırpma YASAK: uygulanan pencere yanıtta görünür olmalı.
    expect(report.window.isDefault).toBe(true);
    expect(report.window.allTime).toBe(false);
    expect(report.window.defaultMonths).toBe(12);
    expect(report.window.from).toBeTruthy();
    // Üst sınır BİLEREK açık (ileri tarihli teslim-alma damgaları düşmesin).
    expect(report.window.to).toBeNull();

    const row = cur3(report.deliveredCogs);
    expect(row).toBeDefined();
    expect(row!.cogsCents).toBe(300); // 18 ay öncesi HARİÇ
    expect(row!.deliveredUnits).toBe(1);
  });

  it('allTime → hiçbir tarih sınırı yok (pencere öncesi kayıtlar geri gelir)', async () => {
    const report = await costs.getCostReport({ allTime: true });

    expect(report.window.allTime).toBe(true);
    expect(report.window.from).toBeNull();
    expect(report.window.to).toBeNull();

    const row = cur3(report.deliveredCogs);
    expect(row!.cogsCents).toBe(1000); // 700 + 300
    expect(row!.deliveredUnits).toBe(2);
  });

  it('açık from/to aralığı YALNIZ o dönemi kapsar (gün girdisi ISO bind ile 500 üretmez)', async () => {
    const report = await costs.getCostReport({
      from: dayStr(monthsAgo(19)),
      to: dayStr(monthsAgo(17)),
    });

    expect(report.window.isDefault).toBe(false);
    expect(report.window.allTime).toBe(false);

    const row = cur3(report.deliveredCogs);
    expect(row).toBeDefined();
    expect(row!.cogsCents).toBe(700); // yalnız eski teslimat
    expect(row!.deliveredUnits).toBe(1);
  });

  it('yalnız from verilirse üst sınır açık kalır; eski kayıt dışarıda kalır', async () => {
    const report = await costs.getCostReport({ from: dayStr(monthsAgo(1)) });
    expect(report.window.to).toBeNull();
    const row = cur3(report.deliveredCogs);
    expect(row!.cogsCents).toBe(300);
  });

  it('gün girdisi olarak verilen `to` O GÜNÜ KAPSAR (gün sonuna genişletilir)', async () => {
    // Taze teslimat BUGÜN yapıldı; `to=bugün` UTC gece yarısı olarak yorumlansaydı
    // bugünün kayıtları sessizce dışarıda kalırdı (operatörün göremediği eksik veri).
    const today = new Date();
    const report = await costs.getCostReport({ from: dayStr(today), to: dayStr(today) });
    const row = cur3(report.deliveredCogs);
    expect(row).toBeDefined();
    expect(row!.deliveredUnits).toBe(1);
    expect(row!.cogsCents).toBe(300);
  });

  it('bozuk tarih VARSAYILAN pencereye düşer ("sınırsız"a değil) ve rapor 500 vermez', async () => {
    // Servis savunmalı davranır (400 üretmek controller'ın işi), AMA bozuk girdinin ödülü
    // tam-tablo taraması olmamalı — bulgunun (O7) kendisi zaten sınırsız taramaydı.
    const report = await costs.getCostReport({ from: 'bu-bir-tarih-degil' });
    expect(report.window.isDefault).toBe(true);
    expect(report.window.from).toBeTruthy();
    const row = cur3(report.deliveredCogs);
    expect(row!.deliveredUnits).toBe(1); // 18 ay öncesi yine HARİÇ
  });
});
