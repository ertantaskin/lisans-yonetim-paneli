import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { SuppliersService } from '../../src/procurement/suppliers.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createProduct,
  createSupplier,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — TEDARİKÇİ KARNESİ: tek tedarikçi yüklemi (R10) + emir listesi zarfı (R3).
 *
 *  R10 — Aynı karne yanıtında İKİ FARKLI "bu parti bu tedarikçiden mi?" tanımı vardı:
 *        `batchCount`/`recallRate` düz `batches.supplier_id = $1`, `defects.*` ise
 *        `coalesce(b.supplier_id, po.supplier_id) = $1`. Parti tedarikçiyi DOĞRUDAN taşımayıp
 *        yalnız satın alma emrinden miras alıyorsa (batches.supplier_id SET NULL'lı bir FK'dir)
 *        aynı ekran "0 parti" derken kusurlu kalem gösteriyordu. Bu test iki sayacı AYNI
 *        veri üzerinde karşılaştırır → tanımlar tekrar ayrışırsa kırmızı yanar.
 *
 *  R3  — `PurchaseOrdersService.list()` LIMIT'siz ve `truncated`'sızdı; bu tablo artık HER
 *        stok girişinde satır kazanıyor. Zarf sözleşmesi (`{ items, truncated }`) burada
 *        kilitlenir.
 */

const tag = randomUUID().slice(0, 8);

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let suppliersSvc: SuppliersService;
let poSvc: PurchaseOrdersService;

describe('SuppliersService.scorecard — parti/kusur yüklemi TEK KAYNAK (R10)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    suppliersSvc = new SuppliersService(db as never);
    poSvc = new PurchaseOrdersService(db as never);
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('tedarikçiyi yalnız satın alma emrinden miras alan parti de karneye SAYILIR', async () => {
    const supplier = await createSupplier(db, { tag });
    const product = await createProduct(db, { tag });

    const [po] = await db
      .insert(schema.purchaseOrders)
      .values({
        supplierId: supplier.id,
        productId: product.id,
        status: 'received',
        qtyOrdered: 5,
        qtyReceived: 5,
        unitCostCents: 100,
      })
      .returning({ id: schema.purchaseOrders.id });

    // (a) supplier_id NULL — tedarikçi YALNIZ emirden çözülür (eski sayaç bunu KAÇIRIYORDU).
    const [inherited] = await db
      .insert(schema.batches)
      .values({
        productId: product.id,
        supplierId: null,
        purchaseOrderId: po!.id,
        label: `${tag}-miras`,
        qtyReceived: 5,
      })
      .returning({ id: schema.batches.id });

    // (b) Tedarikçiyi DOĞRUDAN taşıyan, geri çekilmiş parti.
    await db.insert(schema.batches).values({
      productId: product.id,
      supplierId: supplier.id,
      purchaseOrderId: null,
      label: `${tag}-dogrudan`,
      qtyReceived: 2,
      status: 'recalled',
    });

    // Miras alan partiye bir KUSURLU kalem bağla — kusur karnesi bu partiyi zaten görüyordu.
    const [defective] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      status: 'quarantined',
    });
    await db
      .update(schema.licenseItems)
      .set({ batchId: inherited!.id })
      .where(eq(schema.licenseItems.id, defective!));

    const card = await suppliersSvc.scorecard(supplier.id);

    // Düzeltmeden ÖNCE: batchCount 1, recallRate 1.0 (yalnız doğrudan bağlı parti sayılıyordu).
    expect(card.batchCount).toBe(2);
    expect(card.batches).toHaveLength(2);
    expect(card.batchesTruncated).toBe(false);
    expect(card.recallRate).toBeCloseTo(0.5, 5);

    // İKİ SAYAÇ AYNI KÜMEYİ GÖRÜYOR: kusurlu kalem miras alan partiden geliyor; parti
    // sayacı onu görmeseydi "0 parti ama 1 kusurlu kalem" çelişkisi çıkardı.
    expect(card.defects.totalItems).toBe(1);
    expect(card.defects.deadItems).toBe(1);
    expect(card.defects.unclaimedItems).toBe(1);
  });

  it('R3: emir listesi zarf döner (items + truncated) ve tie-break ile kararlıdır', async () => {
    const supplier = await createSupplier(db, { tag });
    const product = await createProduct(db, { tag });
    // Aynı transaction'da açılan emirler BİREBİR aynı created_at damgasını taşır →
    // tie-break olmadan sıra keyfi olurdu.
    await db.insert(schema.purchaseOrders).values(
      Array.from({ length: 3 }, () => ({
        supplierId: supplier.id,
        productId: product.id,
        status: 'draft' as const,
        qtyOrdered: 1,
      })),
    );

    const first = await poSvc.list();
    expect(Array.isArray(first.items)).toBe(true);
    expect(first.items.length).toBeLessThanOrEqual(PurchaseOrdersService.LIST_LIMIT);
    // Tavana ULAŞILMADIYSA kırpma bayrağı KESİNLİKLE false olmalı (tavan+1 deseni yanlış
    // pozitif üretmez). Paylaşılan test veritabanında toplam emir sayısı bilinmediği için
    // koşullu yazılır — yoksa başka dosyaların artıkları bu testi kırardı.
    if (first.items.length < PurchaseOrdersService.LIST_LIMIT) {
      expect(first.truncated).toBe(false);
    }
    // En yeni önce sıralandığı için bu dosyanın emirleri pencerenin başındadır.
    expect(first.items.filter((r) => r.productSku === product.sku)).toHaveLength(3);

    // Aynı veri, iki çağrı → aynı sıra (tie-break olmasaydı satırlar yer değiştirebilirdi).
    const second = await poSvc.list();
    expect(second.items.map((r) => r.id)).toEqual(first.items.map((r) => r.id));
  });
});
