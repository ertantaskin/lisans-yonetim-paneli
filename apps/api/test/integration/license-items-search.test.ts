import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { StockService } from '../../src/stock/stock.service';
import { ProductsService } from '../../src/products/products.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import { cleanupByTag, createProduct, makeCrypto, makeDb, type Db } from './_helpers';

/**
 * ENTEGRASYON — lisans envanteri ARAMASI (`listLicenseItems({ search })`).
 *
 * NEDEN BU DOSYA VAR: bu ekrandaki kullanıcı şikâyeti tam olarak "aradığımı bulamıyorum"
 * idi. Payload ŞİFRELİDİR, üzerinde LIKE yapılamaz → arama yalnız ANAHTARLI hash eşitliğiyle
 * mümkündür ve bu yüzden "biçim toleransı" (büyük/küçük harf, boşluk) UYGULAMA katmanında
 * varyant üretilerek sağlanır. Tek bir varyantın düşmesi sessizce "sonuç yok" demektir —
 * hata değil, BOŞ LİSTE olarak görünür; en tehlikeli kusur sınıfı budur.
 *
 * Arama yolu şu anda performans için yeniden yazılıyor. Bu dosyanın amacı YENİ bir davranış
 * tanımlamak değil, MEVCUT davranışın aynı kalmasını kilitlemektir:
 *   (a) tam metin · (b) küçük harfli hâli · (c) araya boşluk eklenmiş hâli · (d) son 5 hane
 *   → HEPSİ aynı kalemi döndürür; 4 hane TEK BAŞINA döndürmez (bilinçli kısıt: son-5 hash'i).
 *   (e) ürün ADI ve (f) SKU ekseninden arama da çalışır ("bu üründen kaç kalem var").
 *
 * Ayrıca arama gerçekten DARALTMALI: aynı ürüne ikinci bir anahtar (decoy) girilir ve tam
 * metin aramasının onu DÖNDÜRMEDİĞİ doğrulanır — "her şeyi döndüren" bir arama da yeşil
 * geçerdi, bu yüzden negatif iddia şart.
 */

const tag = randomUUID().slice(0, 8);
const TAG_UP = tag.toUpperCase();
const ACTOR = 'panel:it-li-search';

/**
 * Anahtarın SON 5 hanesi bilerek hex-DIŞI harflerden (Z X Q V W) seçildi: 4 haneli negatif
 * probe ("XQVW") ürün adı/SKU'sundaki rastgele uuid parçasına TESADÜFEN denk gelemesin.
 */
const KEY = `ARAMA-${TAG_UP}-KUYRUK-ZXQVW`;
const DECOY = `ARAMA-${TAG_UP}-DECOY-MNPRS`;

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let stock: StockService;

let productId: string;
let productSku: string;
let productName: string;
let keyItemId: string;
let decoyItemId: string;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const configFake = { get: () => undefined } as never;
const autocompleteQueueFake = { add: async () => ({ id: 'fake' }) } as never;

/** Arama sonucunda bizim kalemimiz var mı? (global liste → id ile kontrol) */
async function search(term: string): Promise<string[]> {
  const page = await stock.listLicenseItems({ search: term, pageSize: 100 }, ACTOR, true);
  return page.rows.map((r) => r.id);
}

describe('lisans envanteri araması — biçim toleransı ve eksenler', () => {
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

    productName = `Arama Testi Urunu ${tag}`;
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      name: productName,
    });
    productId = product.id;
    productSku = product.sku;

    const res = await stock.import(
      productId,
      [{ payload: KEY }, { payload: DECOY }],
      undefined,
      false,
      ACTOR,
    );
    expect(res.imported).toBe(2);

    const page = await stock.listLicenseItems({ productId, pageSize: 100 }, ACTOR, true);
    keyItemId = page.rows.find((r) => r.value === KEY)!.id;
    decoyItemId = page.rows.find((r) => r.value === DECOY)!.id;
  });

  afterAll(async () => {
    // Her liste görüntülemesi TEK 'reveal' audit satırı yazar (§8) — bu koşuya özel aktörü temizle.
    await db.execute(sql`DELETE FROM audit_log WHERE actor = ${ACTOR}`);
    await cleanupByTag(db, tag);
    await end();
  });

  it('(a) TAM metin aramasi kalemi bulur ve DİĞERİNİ döndürmez (arama gerçekten daraltır)', async () => {
    const ids = await search(KEY);
    expect(ids).toContain(keyItemId);
    expect(ids).not.toContain(decoyItemId);
  });

  it('(b) küçük harfle yapıştırılan anahtar da bulunur (kopyala-yapıştır harf farkı)', async () => {
    // Regresyon: hash birebir metin üzerinden hesaplanır → tek varyant denenirse
    // operatörün küçük harfli yapıştırması SESSİZCE "sonuç yok" döner.
    const ids = await search(KEY.toLowerCase());
    expect(ids).toContain(keyItemId);
  });

  it('(c) araya boşluk girmiş / boşlukları sadeleşmiş hâli de bulunur', async () => {
    // "ARAMA-<tag>-KUY  RUK-ZXQVW" → collapsed → boşluksuz → orijinal anahtar.
    const spaced = `${KEY.slice(0, 12)}  ${KEY.slice(12)}`;
    expect(spaced).not.toBe(KEY); // probe gerçekten farklı bir metin
    const ids = await search(spaced);
    expect(ids).toContain(keyItemId);
  });

  it('(d) yalnız SON 5 hane ile bulunur (elde yalnız kuyruk varken)', async () => {
    const ids = await search(KEY.slice(-5));
    expect(ids).toContain(keyItemId);
  });

  it('4 hane TEK BAŞINA bulmaz — bilinçli kısıt (suffix hash 5 hanelidir)', async () => {
    // Bu kısıt gevşerse anahtar kuyruğu brute-force ile taranabilir hâle gelir; testi
    // "boş liste" yerine "bizim kalem YOK" diye yazıyoruz (paylaşılan DB'de başka satırlar olabilir).
    const ids = await search(KEY.slice(-4));
    expect(ids).not.toContain(keyItemId);
  });

  it('(e) ürün ADI ekseninden arama — "bu üründen kaç kalem var" sorusu', async () => {
    // Bu eksen ESKİDEN YOKTU: ürün adı yazınca liste boş dönüyordu (yanıltıcı).
    const ids = await search(productName);
    expect(ids).toEqual(expect.arrayContaining([keyItemId, decoyItemId]));
  });

  it('(f) SKU ekseninden arama', async () => {
    const ids = await search(productSku);
    expect(ids).toEqual(expect.arrayContaining([keyItemId, decoyItemId]));
  });

  it('eşleşmeyen metin bizim kalemlerimizi döndürmez', async () => {
    const ids = await search(`BULUNMAYAN-${TAG_UP}-XXXX`);
    expect(ids).not.toContain(keyItemId);
    expect(ids).not.toContain(decoyItemId);
  });
});
