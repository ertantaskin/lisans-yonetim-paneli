import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { SupplyOpsService } from '../../src/supply-ops/supply-ops.service';
import { StockService } from '../../src/stock/stock.service';
import { ProductsService } from '../../src/products/products.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import { cleanupByTag, createProduct, makeCrypto, makeDb, tagPrefix, type Db } from './_helpers';

/**
 * ENTEGRASYON — TOPLU stok düzeltme (`createAdjustment` + `licenseItemIds[]`).
 *
 * NEDEN BU TEST VAR: bozuk anahtarları tek tek seçmek operasyonel olarak kullanılamazdı,
 * toplu yol eklendi. İlk uygulamada `WHERE id = ANY(${ids}::uuid[])` yazıldı ve Postgres
 * 42846 ("cannot cast") ile 500 döndü — drizzle'ın `sql` şablonunda JS dizisini bu şekilde
 * geçirmek BOZUK SQL üretiyor. Aynı tuzak projede daha önce KVKK anonymize yolunda da
 * yaşanmıştı. typecheck ve build ikisini de yakalamaz; yalnız GERÇEK Postgres'e karşı
 * koşan bir test yakalar. Bu dosya o yolu kalıcı olarak kilitler.
 */

const tag = randomUUID().slice(0, 8);
const ACTOR = 'panel:it-bulk-adjust';

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let stock: StockService;
let supplyOps: SupplyOpsService;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const configFake = { get: () => undefined } as never;
const autocompleteQueueFake = { add: async () => ({ id: 'fake' }) } as never;

async function importKeys(productId: string, keys: string[]): Promise<string[]> {
  /*
   * ANAHTARLAR TAG'LENİR — aksi halde paylaşılan bir DB'de SESSİZCE atlanırlar.
   * `payload_hash` GLOBAL unique ve `stock.import` mükerrerleri `onConflictDoNothing` ile
   * sessizce atlar. Sabit metinler ('BULK-A1'…) MASTER_KEY sabitlendiği anda her koşuda AYNI
   * hash'i üretir → ikinci koşuda `imported` eksilir, `ids` kısalır ve assert'ler gerçek
   * sebebinden UZAKTA patlar ("3 bekleniyordu 2 geldi" gibi). Tag ile her koşu benzersiz.
   */
  const tagged = keys.map((k) => `${tagPrefix(tag)}-${k}`);
  const res = await stock.import(
    productId,
    tagged.map((payload) => ({ payload })),
    undefined,
    false,
    ACTOR,
  );
  // SESSİZ ATLAMA YASAĞI (projenin kendi kuralı): beklenenden az kayıt girdiyse testi burada,
  // net bir mesajla düşür — yoksa hata üç assert sonra ve yanlış sebeple görünür.
  if (res.imported !== tagged.length) {
    throw new Error(
      `Test kurulumu bozuk: ${tagged.length} anahtar beklenirken ${res.imported} girildi ` +
        `(mükerrer: ${res.duplicates ?? 0}). Paylaşılan DB'de tag çakışması olabilir.`,
    );
  }
  const page = await stock.listLicenseItems({ productId, pageSize: 100 }, ACTOR, true);
  // Listeleme "en yeni giriş üstte" → bu testte sıra önemli değil, id kümesi yeterli.
  return page.rows.map((r) => r.id);
}

describe('createAdjustment — toplu geçersiz kılma', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    const products = new ProductsService(db as never);
    const fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    stock = new StockService(
      db as never,
      crypto,
      products,
      fulfillment,
      configFake,
      autocompleteQueueFake,
    );
    // SupplyOpsService ctor'u 3 bağımlılık ister; bu dosyanın kullandığı metotlar (stok
    // düzeltme) adminOrders/fulfillment'a DOKUNMAZ, o yüzden ikisi boş geçilir. Tip olarak
    // da doğru yazılır: eskiden tek argümanla çağrılıyordu ve test dosyaları typecheck'e
    // girmediği için sapma sessizce yaşıyordu.
    supplyOps = new SupplyOpsService(db as never, undefined as never, undefined as never);
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('birden çok kalemi TEK çağrıda düşer; kalem başına ayrı defter satırı yazar', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const ids = await importKeys(product.id, ['BULK-A1', 'BULK-A2', 'BULK-A3', 'BULK-A4']);
    const chosen = ids.slice(0, 3);

    const res = await supplyOps.createAdjustment(
      {
        productId: product.id,
        licenseItemIds: chosen,
        action: 'damage',
        qty: 0,
        reason: 'tedarikçi partisi bozuk',
      },
      ACTOR,
    );

    expect(res.requested).toBe(3);
    expect(res.affected).toBe(3);
    expect(res.skipped).toBe(0);
    // Tek kullanımlık ürün → kalem başına 1 birim fire.
    expect(res.qtyTotal).toBe(3);
    // Karantina ekranı sebebi license_item_id üzerinden okur → kalem başına AYRI satır şart.
    expect(res.rows).toHaveLength(3);
    expect(new Set(res.rows.map((r) => r.licenseItemId))).toEqual(new Set(chosen));

    const after = await stock.listLicenseItems({ productId: product.id, pageSize: 100 }, ACTOR, true);
    const byId = new Map(after.rows.map((r) => [r.id, r.status]));
    for (const id of chosen) expect(byId.get(id)).toBe('voided');
    // Seçilmeyen kalem DOKUNULMADAN kalır.
    const untouched = ids.find((id) => !chosen.includes(id))!;
    expect(byId.get(untouched)).toBe('available');
  });

  it('stokta olmayan kalemleri ATLAR ve dürüstçe raporlar (hepsi-ya-da-hiç DEĞİL)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const ids = await importKeys(product.id, ['BULK-B1', 'BULK-B2']);

    // Birini önceden düş → ikinci çağrıda 'available' olmadığı için atlanmalı.
    await supplyOps.createAdjustment(
      { productId: product.id, licenseItemIds: [ids[0]!], action: 'void', qty: 0, reason: 'ilk' },
      ACTOR,
    );

    const res = await supplyOps.createAdjustment(
      {
        productId: product.id,
        // zaten düşülen + hâlâ stokta olan + hiç var olmayan
        licenseItemIds: [ids[0]!, ids[1]!, randomUUID()],
        action: 'void',
        qty: 0,
        reason: 'ikinci tur',
      },
      ACTOR,
    );

    expect(res.requested).toBe(3);
    expect(res.affected).toBe(1);
    expect(res.skipped).toBe(2);
  });

  it('hiçbiri işlenemezse 400 atar (sessizce "başarılı" demez)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    await expect(
      supplyOps.createAdjustment(
        {
          productId: product.id,
          licenseItemIds: [randomUUID(), randomUUID()],
          action: 'void',
          qty: 0,
          reason: 'yok',
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('MAK/çok kullanımlıkta fire KALAN KAPASİTE kadar yazılır (form adedi değil)', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'multi',
      maxUses: 50,
    });
    const ids = await importKeys(product.id, ['BULK-MAK-1']);

    const res = await supplyOps.createAdjustment(
      { productId: product.id, licenseItemIds: ids, action: 'damage', qty: 0, reason: 'MAK bozuk' },
      ACTOR,
    );

    expect(res.affected).toBe(1);
    expect(res.qtyTotal).toBe(50);
  });

  it('kalem verilmeyen "correct" YALNIZ defter kaydı yazar, stok değişmez', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const ids = await importKeys(product.id, ['BULK-C1']);

    const res = await supplyOps.createAdjustment(
      { productId: product.id, action: 'correct', qty: 7, reason: 'sayım notu' },
      ACTOR,
    );

    expect(res.affected).toBe(0);
    expect(res.qtyTotal).toBe(7);
    expect(res.rows).toHaveLength(1);

    const after = await stock.listLicenseItems({ productId: product.id, pageSize: 100 }, ACTOR, true);
    expect(after.rows.find((r) => r.id === ids[0])?.status).toBe('available');
  });
});
