import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../../src/db/schema';
import { assignAvailableSingleUse } from '../../src/assignment/assign';
import { CryptoService } from '../../src/crypto/crypto.service';
import { cleanupByTag, createProduct, insertLicenseItems, makeCrypto, makeDb, type Db } from './_helpers';

/**
 * ENTEGRASYON — atama motorunun EN TEMEL sözü: "istenen kadar ata, fazlasını DEĞİL".
 *
 * NEDEN VAR (ölçülmüş üretim hatası): `assignAvailableSingleUse` eski hâlinde
 * `UPDATE license_items WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` yazıyordu.
 * READ COMMITTED'da UPDATE, hedef satırı eşzamanlı değiştirilmiş bulursa satırın YENİ sürümü
 * üzerinde WHERE'i yeniden değerlendirir (EvalPlanQual) ve `IN (…)` alt sorgusu YENİDEN KOŞAR;
 * her koşuda "ilk n" baştan seçildiği ve `SKIP LOCKED` farklı satırları atladığı için kümelerin
 * BİRLEŞİMİ güncellenir → LIMIT fiilen kalkar.
 *
 * Somut ölçüm (izole PostgreSQL, tek süreç, ~3 koşumda 1): `qty=6` istenirken sorgu **20**
 * satır — o ürünün TÜM stoğu — döndürdü ve hepsi tek sipariş satırına atandı; motorun kendi
 * olayı `+20 atandı (20/6)` yazdı. Yani müşteriye bedava lisans, envanterden sessiz yanma.
 * Aralıklı olduğu için uzun süre "test gürültüsü" sanılmıştı.
 *
 * DÜZELTME: seçim MATERIALIZED bir CTE'de bir kez yapılır (MAK yolunun zaten kullandığı desen)
 * + fonksiyonda fail-closed kalkan (istenenden fazla dönerse transaction patlar).
 *
 * BU TEST NE YAPAR / NE YAPMAZ: yarışı ÜRETMEZ (üretilebilir olsaydı hata zaten aralıklı
 * olmazdı); sözleşmeyi kilitler — stok taleple ÇOK daha fazlayken bile dönen kalem sayısı
 * tam olarak istenendir. Gerçek koruma koddaki kalkandır: desen geri alınırsa yarış oluştuğu
 * anda sessiz aşırı teslimat yerine GÖRÜNÜR hata (rollback) verir.
 */

const tag = randomUUID().slice(0, 8);

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;

describe('assignAvailableSingleUse — istenenden fazla atamaz', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('stok talepten çok fazlayken tam olarak istenen kadar kalem atanır', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    await insertLicenseItems(db, crypto, { productId: product.id, count: 20, tag });

    const ids = await assignAvailableSingleUse(db as never, product.id, 6);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6); // aynı kalem iki kez dönmez

    const assigned = await db
      .select({ id: schema.licenseItems.id })
      .from(schema.licenseItems)
      .where(
        and(eq(schema.licenseItems.productId, product.id), eq(schema.licenseItems.status, 'assigned')),
      );
    // DB gerçeği de aynı olmalı: 14 kalem stokta KALIR (eski hatada 0 kalıyordu).
    expect(assigned).toHaveLength(6);
  });

  it('stok talepten AZ ise eldeki kadar atanır (kısmi teslimat yolu bozulmaz)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    await insertLicenseItems(db, crypto, { productId: product.id, count: 3, tag });

    const ids = await assignAvailableSingleUse(db as never, product.id, 10);
    expect(ids).toHaveLength(3);
  });

  it('süresi geçmiş kalem atanmaz (yüklem CTE taşımasında korunmuş olmalı)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 2,
      tag,
      expiresAt: new Date(Date.now() - 86_400_000),
    });
    await insertLicenseItems(db, crypto, { productId: product.id, count: 1, tag });

    const ids = await assignAvailableSingleUse(db as never, product.id, 5);
    // Yalnız süresi geçmemiş TEK kalem atanır; iki bayat kalem havuzda kalır.
    expect(ids).toHaveLength(1);
  });
});
