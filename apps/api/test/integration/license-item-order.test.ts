import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StockService } from '../../src/stock/stock.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { ProductsService } from '../../src/products/products.service';
import { assignAvailableSingleUse } from '../../src/assignment/assign';
import type { CryptoService } from '../../src/crypto/crypto.service';
import { cleanupByTag, createProduct, makeCrypto, makeDb, type Db } from './_helpers';

/**
 * ENTEGRASYON — lisans envanterinde EKLEME SIRASI korunur (`license_items.seq`).
 *
 * KÖK NEDEN (dev DB'de gerçek veriyle ölçüldü, varsayım değil): bir içe aktarmanın TÜM
 * satırları tek transaction'da yazılır, bu yüzden `created_at` hepsinde AYNIDIR (15 satırlık
 * bir giriş tek damga). Sıralamanın tie-break'i rastgele UUID (`id`) olduğu sürece operatörün
 * yapıştırdığı liste ekranda KARIŞIK görünür — kullanıcı şikâyeti tam olarak buydu.
 *
 * Bu dosya iki ayrı vaadi kilitler:
 *   1. LİSTELEME — "en yeni giriş üstte, blok içinde yapıştırılan sıra".
 *   2. TESLİMAT (FIFO) — aynı partide önce girilen anahtar önce atanır.
 *
 * NOT: tie-break olmadan bu testler ARADA yeşil kalabilirdi (rastgele sıra tesadüfen doğru
 * çıkabilir). Bu yüzden satır sayısı 8 tutuldu: 8! = 40.320 permütasyon → yanlış davranışın
 * tesadüfen geçme olasılığı ihmal edilebilir.
 */

const tag = randomUUID().slice(0, 8);
const ACTOR = 'panel:it-order';

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let products: ProductsService;
let stock: StockService;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const configFake = { get: () => undefined } as never;
const autocompleteQueueFake = { add: async () => ({ id: 'fake' }) } as never;

/** Sıra sabit ve gözle okunur olsun: 01..08. */
const KEYS_A = Array.from({ length: 8 }, (_, i) => `SIRA-A-${String(i + 1).padStart(2, '0')}`);
const KEYS_B = Array.from({ length: 3 }, (_, i) => `SIRA-B-${String(i + 1).padStart(2, '0')}`);

/**
 * Listeleme satırlarından düz anahtar metnini çıkarır. Alan adı `value`
 * (`LicenseInventoryRow.value`) — owner görünümünde (reveal=true) maskesiz gelir.
 */
function plainKeys(rows: Array<{ value: string | null }>): string[] {
  return rows.map((r) => r.value ?? '');
}

describe('license_items.seq — içe aktarma sırası listede ve teslimatta korunur', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    products = new ProductsService(db as never);
    const fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    stock = new StockService(
      db as never,
      crypto,
      products,
      fulfillment,
      configFake,
      autocompleteQueueFake,
    );
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('(1) tek içe aktarma: liste operatörün girdiği sırayı AYNEN gösterir', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const res = await stock.import(
      product.id,
      KEYS_A.map((payload) => ({ payload })),
      undefined,
      false,
      ACTOR,
    );
    expect(res.imported).toBe(KEYS_A.length);

    // Varsayılan sıra ('created_desc') → aynı damgalı blok içinde seq ASC.
    const page = await stock.listLicenseItems({ productId: product.id }, ACTOR, true);
    expect(plainKeys(page.rows)).toEqual(KEYS_A);
  });

  it('(2) ikinci içe aktarma BLOK OLARAK üste gelir; her blok kendi içinde sıralı kalır', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    await stock.import(product.id, KEYS_A.map((payload) => ({ payload: `${payload}-X` })), undefined, false, ACTOR);
    // İkinci giriş AYRI transaction → farklı created_at damgası.
    await stock.import(product.id, KEYS_B.map((payload) => ({ payload: `${payload}-X` })), undefined, false, ACTOR);

    const page = await stock.listLicenseItems({ productId: product.id }, ACTOR, true);
    expect(plainKeys(page.rows)).toEqual([
      ...KEYS_B.map((k) => `${k}-X`), // en yeni blok üstte
      ...KEYS_A.map((k) => `${k}-X`), // altında ilk blok, kendi sırasıyla
    ]);
  });

  it('(3) "En eski giriş üstte" sıralaması tam tersini verir (blok sırası döner, blok içi sıra KORUNUR)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    await stock.import(product.id, KEYS_A.map((payload) => ({ payload: `${payload}-Y` })), undefined, false, ACTOR);
    await stock.import(product.id, KEYS_B.map((payload) => ({ payload: `${payload}-Y` })), undefined, false, ACTOR);

    const page = await stock.listLicenseItems(
      { productId: product.id, sort: 'created_asc' },
      ACTOR,
      true,
    );
    expect(plainKeys(page.rows)).toEqual([
      ...KEYS_A.map((k) => `${k}-Y`),
      ...KEYS_B.map((k) => `${k}-Y`),
    ]);
  });

  it('(4) FIFO: aynı partiden önce GİRİLEN anahtar önce ATANIR', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    await stock.import(product.id, KEYS_A.map((payload) => ({ payload: `${payload}-Z` })), undefined, false, ACTOR);

    // İlk 3'ü ata — sıra rastgele olsaydı bu üçlü KEYS_A'nın ilk üçü OLMAZDI.
    const assigned = await assignAvailableSingleUse(db as never, product.id, 3);
    expect(assigned).toHaveLength(3);

    const page = await stock.listLicenseItems(
      { productId: product.id, status: 'assigned' },
      ACTOR,
      true,
    );
    // Atanmışlar da giriş sırasında listelenir → ilk üç anahtar.
    expect(plainKeys(page.rows).sort()).toEqual(
      KEYS_A.slice(0, 3).map((k) => `${k}-Z`).sort(),
    );
  });
});
