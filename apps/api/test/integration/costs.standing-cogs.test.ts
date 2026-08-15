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
  createSupplier,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  type CreatedSite,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — MALİYET RAPORU: iki denetim bulgusunun REGRESYON kilidi.
 *
 *  R4 — `deliveredCogs` "ayakta atama" kümesinden sapıyordu (`status = 'active'`), oysa
 *       panelin her yerinde ayakta küme `active | suspended | expired`. Askıya alınan bir
 *       anahtar müşterinin ELİNDEDİR (§4 geçici gizleme, iade DEĞİL); süresi dolmuş süreli
 *       hesap da teslim EDİLMİŞTİ ve §2 gereği hak geri gelmez. İkisi de dışlanınca AYNI
 *       EKRANDAKİ satış hızı ile COGS çelişiyordu ("satıldı ama maliyeti yok").
 *
 *  R9 — `byMonth` INNER JOIN purchase_orders kullanıyordu → satın alma emrine bağlı OLMAYAN
 *       parti (tedarikçisiz elle stok girişi) hiçbir aya girmiyor, SESSİZCE kayboluyordu.
 *
 * İZOLASYON: rapor GLOBAL agregasyon yapar (tag süzgeci yok) → satırlar BENZERSİZ para
 * birimi + gerçek veride bulunması imkânsız bir AY (2001-03) ile ayrıştırılır.
 */

const tag = randomUUID().slice(0, 8);
/** Benzersiz para birimi — başka test dosyalarının satırlarıyla karışmaz. */
const CUR = `C1${tag.slice(0, 4)}`;
/** Gerçek veride bulunmayan teslim-alma ayı (byMonth kovası bu testin tekelinde). */
const OLD_MONTH = '2001-03';
const OLD_MONTH_AT = new Date('2001-03-15T10:00:00.000Z');

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let costs: CostsService;
let site: CreatedSite;

describe('CostsService — ayakta COGS kümesi (R4) + aylık kapsanamayan (R9)', () => {
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

  it('R4: askıdaki ve süresi dolmuş TESLİMATLAR da COGS-a girer; iade/değişim GİRMEZ', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    // 5 kalem, hepsi AYNI birim maliyet (100 kuruş) ve AYNI benzersiz para birimi →
    // beklenen toplam yalnız "kaç atama sayıldı" sorusuna indirgenir.
    const items = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 5,
      tag,
      status: 'assigned',
    });
    for (const id of items) {
      await db
        .update(schema.licenseItems)
        .set({ unitCostCents: 100, costCurrency: CUR })
        .where(eq(schema.licenseItems.id, id));
    }

    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 5,
      tag,
    });

    // AYAKTA olan üç statü — üçü de TESLİM EDİLMİŞ sayılır.
    const standing = ['active', 'suspended', 'expired'] as const;
    // Gerçek iade + değişimde net'lenen eski atama — maliyete GİRMEMELİ.
    const dropped = ['revoked', 'replaced'] as const;
    const statuses = [...standing, ...dropped];

    for (const [i, status] of statuses.entries()) {
      await db.insert(schema.assignments).values({
        orderId: order.orderId,
        lineId: order.lineId,
        licenseItemId: items[i]!,
        units: 1,
        status,
        deliveredAt: new Date(),
      });
    }

    const report = await costs.getCostReport();
    const row = report.deliveredCogs.find((r) => r.currency === CUR);
    expect(row).toBeDefined();

    // ÜÇ ayakta atama × 100 kuruş = 300. Düzeltmeden ÖNCE 100 dönerdi (yalnız 'active').
    expect(row!.deliveredUnits).toBe(3);
    expect(row!.cogsCents).toBe(300);
    // revoked/replaced sayılsaydı 500 olurdu — iade edilen anahtarın maliyeti yazılmaz.
    expect(row!.cogsCents).not.toBe(500);
  });

  it('R9: satın alma emrine bağlı OLMAYAN parti aylık raporda KAYBOLMAZ (kapsanamayan)', async () => {
    const product = await createProduct(db, { tag });
    const supplier = await createSupplier(db, { tag });

    // (a) Maliyeti bilinen emir → parasal toplama girer.
    const [poWithCost] = await db
      .insert(schema.purchaseOrders)
      .values({
        supplierId: supplier.id,
        productId: product.id,
        status: 'received',
        qtyOrdered: 4,
        qtyReceived: 4,
        unitCostCents: 250,
        currency: CUR,
      })
      .returning({ id: schema.purchaseOrders.id });
    // (b) Emir VAR ama birim maliyeti girilmemiş → aynı para biriminde 'kapsanamayan'.
    const [poNoCost] = await db
      .insert(schema.purchaseOrders)
      .values({
        supplierId: supplier.id,
        productId: product.id,
        status: 'received',
        qtyOrdered: 3,
        qtyReceived: 3,
        unitCostCents: null,
        currency: CUR,
      })
      .returning({ id: schema.purchaseOrders.id });

    await db.insert(schema.batches).values([
      {
        productId: product.id,
        supplierId: supplier.id,
        purchaseOrderId: poWithCost!.id,
        label: `${tag}-po-maliyetli`,
        qtyReceived: 4,
        receivedAt: OLD_MONTH_AT,
      },
      {
        productId: product.id,
        supplierId: supplier.id,
        purchaseOrderId: poNoCost!.id,
        label: `${tag}-po-maliyetsiz`,
        qtyReceived: 3,
        receivedAt: OLD_MONTH_AT,
      },
      {
        // (c) EMİRSİZ parti — tedarikçisiz elle stok girişinin ürettiği kayıt.
        // Düzeltmeden ÖNCE bu satır INNER JOIN yüzünden raporda HİÇ görünmüyordu.
        productId: product.id,
        supplierId: supplier.id,
        purchaseOrderId: null,
        label: `${tag}-emirsiz`,
        qtyReceived: 7,
        receivedAt: OLD_MONTH_AT,
      },
    ]);

    /*
     * `allTime` ŞART: rapor artık parametresiz çağrıldığında VARSAYILAN pencereyi (son 12 ay)
     * uygular (denetim bulgusu O7 — penceresiz tam-tablo taraması). Bu testin ayrıştırıcı
     * kovası 2001-03 olduğu için varsayılan pencerede satır DÖNMEZ; ölçülmek istenen davranış
     * (R9 kapsanamayan parti) pencereden bağımsızdır → sınır açıkça kaldırılır.
     */
    const report = await costs.getCostReport({ allTime: true });
    const rows = report.byMonth.filter((r) => r.month === OLD_MONTH);

    const priced = rows.find((r) => r.currency === CUR);
    expect(priced).toBeDefined();
    expect(priced!.spentCents).toBe(4 * 250);
    // Maliyeti girilmemiş emir parasal toplama KATILMAZ ama miktarı görünür.
    expect(priced!.uncoveredQty).toBe(3);

    // Emirsiz parti: para birimi bilinmiyor → '' satırı (valuation/deliveredCogs deseni).
    const unpriced = rows.find((r) => r.currency === '');
    expect(unpriced).toBeDefined();
    expect(unpriced!.uncoveredQty).toBe(7);
    expect(unpriced!.spentCents).toBe(0);
  });
});
