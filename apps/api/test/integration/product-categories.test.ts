import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema';
import {
  ProductCategoriesService,
  UNCATEGORIZED_ID,
} from '../../src/products/product-categories.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createProduct,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  tagPrefix,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — ürün kategorileri (migration 0037 + 0038).
 *
 * NEDEN BU DOSYA VAR: kategori tablosunun TEK varlık sebebi ikiz kategoriyi engellemektir,
 * ama bu davranışın hiç testi yoktu. Üstelik ilk sürüm (0037) düz `lower()` unique index'i
 * kullanıyordu ve dev'de ÖLÇÜLDÜ ki en_US.utf8 collation'da
 *   lower('WINDOWS LİSANSLARI') = "windows lisanslari"
 *   lower('windows lisansları') = "windows lisansları"
 * → dört Türkçe varyant (i · ı · İ · I) FARKLI sayılıyor ve ikiz kategori 201 ile KABUL
 * EDİLİYORDU. 0038 index'i `lower(translate(name,'İIı','iii'))` ile bunu kapattı; aşağıdaki
 * testler o kapıyı kalıcı olarak kilitler.
 *
 * İkinci kilitlenen sözleşme SİLME'dir: kategori silinince ÜRÜN SİLİNMEZ (`ON DELETE SET NULL`)
 * ve kaç ürünün "Kategorisiz" kovasına düştüğü yanıtta döner. RESTRICT'e kayarsa operatör her
 * ürünü elle taşımak zorunda kalır; CASCADE'e kayarsa stok/sipariş taşıyan ürünler silinir
 * (felaket). Üçüncüsü LİSTE SIRASI: kullanıcı kararı "stoğu fazla olan kategori üstte,
 * Kategorisiz her zaman sonda, elle sabitlenenler (sort_order>0) hepsinden önce".
 *
 * TEMİZLİK NOTU: `cleanupByTag` product_categories'e DOKUNMAZ (tag'i sku/domain üzerinden
 * bulur) → bu dosya kendi kategorilerini ad önekiyle kendisi siler.
 */

const tag = randomUUID().slice(0, 8);
const prefix = tagPrefix(tag);

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let categories: ProductCategoriesService;

/** Ürünü bir kategoriye bağlar (createProduct helper'ı categoryId almıyor). */
async function assignCategory(productId: string, categoryId: string | null): Promise<void> {
  await db
    .update(schema.products)
    .set({ categoryId })
    .where(eq(schema.products.id, productId));
}

describe('ürün kategorileri — Türkçe ikiz engeli, silme sözleşmesi, liste sırası', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    categories = new ProductCategoriesService(db as never);
  });

  afterAll(async () => {
    // Önce ürün/stok (tag kapsamı), sonra bu dosyanın kategorileri.
    await cleanupByTag(db, tag);
    await db.execute(sql`DELETE FROM product_categories WHERE name LIKE ${`${prefix}-%`}`);
    await end();
  });

  it('Türkçe İ/I/ı/i varyantı İKİZ kategori sayılır — 0038 indeksinin yakalaması gereken vaka', async () => {
    // Regresyon: düz lower() bu ikinci çağrıyı 201 ile KABUL ediyordu (ölçüldü).
    const first = await categories.create({ name: `${prefix}-Windows lisansları` });
    expect(first!.id).toBeTruthy();

    await expect(
      categories.create({ name: `${prefix}-WINDOWS LİSANSLARI` }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Ham 23505 sızmamalı: kullanıcıya 409 + okunur mesaj döner.
    await expect(
      categories.create({ name: `${prefix}-wIndows lisansları` }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('gerçekten FARKLI ad kabul edilir (index fazla geniş değil)', async () => {
    // Ters yön kilidi: ikiz engeli meşru kategorileri bloklamamalı.
    const row = await categories.create({ name: `${prefix}-Office lisansları` });
    expect(row!.name).toBe(`${prefix}-Office lisansları`);

    const other = await categories.create({ name: `${prefix}-Oyun hesapları` });
    expect(other!.id).not.toBe(row!.id);
  });

  it('update() ile mevcut bir adın VARYANTINA yeniden adlandırmak da çakışır', async () => {
    // Regresyon: create yolu korunup update yolu açık kalırsa ikiz kategori arka kapıdan girer.
    await categories.create({ name: `${prefix}-Yapay zeka lisansları` });
    const target = await categories.create({ name: `${prefix}-Gecici kategori` });

    await expect(
      categories.update(target!.id, { name: `${prefix}-YAPAY ZEKA LİSANSLARI` }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Çakışmayan yeniden adlandırma çalışmaya devam eder.
    const renamed = await categories.update(target!.id, { name: `${prefix}-Yenilenmis kategori` });
    expect(renamed!.name).toBe(`${prefix}-Yenilenmis kategori`);
  });

  it('kategori silinince ÜRÜN SİLİNMEZ — category_id NULL olur ve sayı yanıtta döner', async () => {
    // Regresyon: FK CASCADE'e kayarsa stok/sipariş taşıyan ürünler kategoriyle birlikte gider;
    // RESTRICT'e kayarsa silme hiç çalışmaz. Doğru sözleşme SET NULL + dürüst sayaçtır.
    const cat = await categories.create({ name: `${prefix}-Silinecek kategori` });
    const p1 = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const p2 = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    await assignCategory(p1.id, cat!.id);
    await assignCategory(p2.id, cat!.id);

    const res = await categories.remove(cat!.id);
    expect(res.id).toBe(cat!.id);
    expect(res.uncategorizedProducts).toBe(2);

    // Ürünler HÂLÂ duruyor ve kategorisiz.
    const rows = await db
      .select({ id: schema.products.id, categoryId: schema.products.categoryId })
      .from(schema.products)
      .where(inArray(schema.products.id, [p1.id, p2.id]));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.categoryId === null)).toBe(true);
  });

  it('list() sırası: sabitlenmişler önce → stok çoktan aza → "Kategorisiz" HER ZAMAN sonda', async () => {
    // Regresyon: sıralama UNION'ın doğrudan ORDER BY'ına yazılırsa Postgres 0A000 verir
    // (dev'de 500 ile ölçüldü) ve "Kategorisiz" kovası listenin ortasına düşerse operatör
    // artık kovasını gerçek bir kategori sanar. Sabitleme (sort_order>0) stok sırasını EZER.
    const pinned = await categories.create({ name: `${prefix}-Sabit kategori`, sortOrder: 3 });
    const rich = await categories.create({ name: `${prefix}-Cok stoklu` });
    const poor = await categories.create({ name: `${prefix}-Az stoklu` });

    const pPinned = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const pRich = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const pPoor = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    // Kategorisiz kovasının GERÇEKTEN var olması için kategorisiz bir ürün de gerekir.
    await createProduct(db, { tag, kind: 'key', usageMode: 'single' });

    await assignCategory(pPinned.id, pinned!.id);
    await assignCategory(pRich.id, rich!.id);
    await assignCategory(pPoor.id, poor!.id);

    // Sabitlenen kategoride HİÇ stok yok → yalnız sort_order sayesinde başa gelmeli.
    await insertLicenseItems(db, crypto, { productId: pRich.id, count: 5, tag });
    await insertLicenseItems(db, crypto, { productId: pPoor.id, count: 1, tag });

    const list = await categories.list();

    // Global liste (başka kategoriler de olabilir) → KENDİ alt dizimizin sırası kontrol edilir;
    // süzme göreli sırayı korur, bu yüzden iddia geçerlidir.
    const mine = list.filter((r) => r.name.startsWith(prefix)).map((r) => r.name);
    const idx = (n: string) => mine.indexOf(`${prefix}-${n}`);
    expect(idx('Sabit kategori')).toBeGreaterThanOrEqual(0);
    expect(idx('Sabit kategori')).toBeLessThan(idx('Cok stoklu'));
    expect(idx('Cok stoklu')).toBeLessThan(idx('Az stoklu'));

    // Sayaçlar: kapasite (satır sayısı değil, tek kullanımlıkta ikisi eşit) + ürün sayısı.
    const richRow = list.find((r) => r.name === `${prefix}-Cok stoklu`)!;
    expect(richRow.productCount).toBe(1);
    expect(richRow.availableStock).toBe(5);

    // "Kategorisiz" kovası listenin EN SONUNDA — bir kategori değil, artık kovasıdır.
    expect(list[list.length - 1]!.id).toBe(UNCATEGORIZED_ID);
  });

  it('MAK ürününde kategori stoğu KAPASİTEDİR (satır sayısı değil)', async () => {
    // Regresyon: satır saymak MAK'ta "1 stok" gösterip yanlış düşük-stok alarmı üretirdi
    // (panelde daha önce günlük özet sayacında yaşanmış sınıf).
    const cat = await categories.create({ name: `${prefix}-MAK kategorisi` });
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'multi',
      maxUses: 500,
    });
    await assignCategory(product.id, cat!.id);
    await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      maxUses: 500,
    });

    const row = (await categories.list()).find((r) => r.id === cat!.id)!;
    expect(row.productCount).toBe(1);
    expect(row.availableStock).toBe(500);
  });
});
