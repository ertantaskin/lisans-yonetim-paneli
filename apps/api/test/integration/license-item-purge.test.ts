import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema';
import { StockService } from '../../src/stock/stock.service';
import { ProductsService } from '../../src/products/products.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createOrderWithLine,
  createProduct,
  createSite,
  makeCrypto,
  makeDb,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — lisans kaleminin KALICI SİLİNMESİ (`purgeLicenseItem`).
 *
 * NEDEN BU DOSYA VAR (operatör bildirdi, kodda doğrulandı): mükerrer engeli
 * `license_items_payload_hash_uniq` TAM bir UNIQUE index'tir ve statüye HİÇ bakmaz. "Sil"
 * düğmesi kaydı silmiyor, yalnız `voided` yapıyordu → yanlışlıkla girilen bir anahtar tabloda
 * kaldığı için AYNI anahtar bir daha GİRİLEMİYORDU (import onu sessizce "mükerrer" sayıp
 * atlıyordu). Üretimde tek bir `DELETE FROM license_items` yolu bile yoktu, yani operatörün
 * hiçbir çıkışı yoktu.
 *
 * Kilitlenen sözleşmeler:
 *   · purge SONRASI aynı anahtar tekrar girilebilir  ← ASIL KANIT (1. test)
 *   · yalnız `voided` kalem silinebilir (iki adımlı kapı)
 *   · müşteriye BİR KEZ dokunmuş anahtar ASLA silinemez — geçmiş (revoked) atama dahil
 *   · değişim soyağacı / tedarikçi fişi / parti geri çekmesi ayrı ayrı bloklar
 *   · denetim izi silmeden SONRA da ayakta kalır ve düz anahtarı TAŞIMAZ
 */

const tag = randomUUID().slice(0, 8);
const ACTOR = 'panel:it-li-purge';

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let stock: StockService;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const configFake = { get: () => undefined } as never;
const autocompleteQueueFake = { add: async () => ({ id: 'fake' }) } as never;

/** Bu koşuya özgü anahtar üretir (paralel koşumlar ve gerçek veri etkilenmez). */
const keyOf = (suffix: string) => `PURGE-${tag}-${suffix}`;

/** Ürüne tek bir anahtar girer ve kalem id'sini döndürür (import yolunun kendisi kullanılır). */
async function importOne(productId: string, payload: string): Promise<string> {
  const res = await stock.import(productId, [{ payload }], undefined, false, ACTOR);
  expect(res.imported).toBe(1);
  const [row] = await db
    .select({ id: schema.licenseItems.id })
    .from(schema.licenseItems)
    .where(eq(schema.licenseItems.payloadHash, crypto.payloadHash(payload)));
  return row!.id;
}

/** Kalemi iptal edilmiş (voided) duruma getirir — purge'ün ön koşulu. */
async function voidIt(id: string): Promise<void> {
  await stock.voidLicenseItem(id, 'test: yanlış girildi', ACTOR);
}

describe('lisans kalemi KALICI SİLME (purge)', () => {
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
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM audit_log WHERE actor = ${ACTOR}`);
    await cleanupByTag(db, tag);
    await end();
  });

  /**
   * ASIL KANIT — bildirilen arızanın tam senaryosu, önce ARIZAYI sonra ÇÖZÜMÜ ölçer.
   * İkinci adımdaki `duplicates: 1` beklentisi şart: onsuz test, mükerrer engeli hiç
   * çalışmasa bile yeşil kalırdı ve "purge gerekliydi" iddiasını KANITLAMAZDI.
   */
  it('purge sonrası AYNI anahtar tekrar girilebilir (bildirilen arıza)', async () => {
    const product = await createProduct(db, { tag });
    const key = keyOf('ASIL');

    const id = await importOne(product.id, key);
    await voidIt(id);

    // ARIZA: iptal edilmiş kayıt hash'i işgal ettiği için aynı anahtar GİRİLEMİYOR.
    const blocked = await stock.import(product.id, [{ payload: key }], undefined, false, ACTOR);
    expect(blocked.imported).toBe(0);
    expect(blocked.duplicates).toBe(1);

    // ÇÖZÜM.
    const purged = await stock.purgeLicenseItem(id, 'yanlış yazıldı, doğrusu girilecek', ACTOR);
    expect(purged.status).toBe('purged');

    const again = await stock.import(product.id, [{ payload: key }], undefined, false, ACTOR);
    expect(again.imported).toBe(1);

    // Yeni satır GERÇEKTEN satılabilir (sadece "yazıldı" değil).
    const rows = await db
      .select({ id: schema.licenseItems.id, status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.payloadHash, crypto.payloadHash(key)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('available');
    expect(rows[0]!.id).not.toBe(id); // eski satır gerçekten gitti, diriltilmedi
  });

  it('SATILABILIR kalem purge EDİLEMEZ — önce "Sil" (iki adımlı kapı) ve satır DURUR', async () => {
    const product = await createProduct(db, { tag });
    const id = await importOne(product.id, keyOf('AVAIL'));

    await expect(stock.purgeLicenseItem(id, 'olmamalı', ACTOR)).rejects.toThrow(ConflictException);

    const [row] = await db
      .select({ status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, id));
    expect(row?.status).toBe('available');
  });

  it('KARANTİNADAKİ kalem purge EDİLEMEZ (defter tedarikçi bildirimi için durur)', async () => {
    const product = await createProduct(db, { tag });
    const id = await importOne(product.id, keyOf('QUAR'));
    await db
      .update(schema.licenseItems)
      .set({ status: 'quarantined' })
      .where(eq(schema.licenseItems.id, id));

    await expect(stock.purgeLicenseItem(id, 'olmamalı', ACTOR)).rejects.toThrow(ConflictException);
  });

  /**
   * H1 SINIFI KİLİT: atama GEÇMİŞTE kalmış olsa (revoked) bile anahtar müşteriye gitmiştir.
   * Ayrıca hatanın ham FK ihlali (23503) değil, ANLAŞILIR bir 409 olduğu doğrulanır — guard
   * kaldırılırsa test yine kırmızı olur ama BAŞKA bir hatayla; ikisi farklı sonuçtur.
   */
  it('GEÇMİŞ ataması olan kalem purge EDİLEMEZ (revoked dahil) ve satır DURUR', async () => {
    const product = await createProduct(db, { tag });
    const id = await importOne(product.id, keyOf('HIST'));

    const site = await createSite(db, crypto, { tag });
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
    });
    await db.insert(schema.assignments).values({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: id,
      units: 1,
      status: 'revoked',
    });
    // Kalemi elle `voided` yap: normal yollarla bu bileşim oluşmaz, guard'ın kendisi ölçülüyor.
    await db
      .update(schema.licenseItems)
      .set({ status: 'voided' })
      .where(eq(schema.licenseItems.id, id));

    await expect(stock.purgeLicenseItem(id, 'olmamalı', ACTOR)).rejects.toThrow(ConflictException);

    const [row] = await db
      .select({ id: schema.licenseItems.id })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, id));
    expect(row).toBeDefined();
  });

  /**
   * DÜRÜSTLÜK NOTU: bu guard bugün SAVUNMA-DERİNLİĞİdir, tek başına ulaşılan bir yol değil.
   * Gerçek değişim akışında eski kalemin atama satırı `replaced` durumunda TABLODA KALIR →
   * senaryoyu zaten G3 (hiç atama olmamalı) yakalar. `assignment_history.old_license_item_id`
   * FK'sizdir; kalemi silmek soyağacını sessizce sarkan bir referansa çevirirdi, o yüzden ayrı
   * kapı duruyor. Test bu yüzden durumu DOĞRUDAN kurar: soyağacı BAŞKA bir kalemin atamasına
   * bağlıdır, `old_license_item_id` bizim kalemi işaret eder — yani G3 devre dışı, ölçülen
   * şey YALNIZCA G4.
   */
  it('DEĞİŞİM soyağacında geçen kalem purge EDİLEMEZ (zincir kopmasın)', async () => {
    const product = await createProduct(db, { tag });
    const id = await importOne(product.id, keyOf('CHAIN'));
    const otherId = await importOne(product.id, keyOf('CHAIN-YENI'));
    await voidIt(id);

    const site = await createSite(db, crypto, { tag });
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
    });
    const [asg] = await db
      .insert(schema.assignments)
      .values({
        orderId: order.orderId,
        lineId: order.lineId,
        licenseItemId: otherId, // TAZE kalem — soyağacının "yeni" ucu
        units: 1,
        status: 'active',
      })
      .returning({ id: schema.assignments.id });
    await db.insert(schema.assignmentHistory).values({
      assignmentId: asg!.id,
      oldLicenseItemId: id, // silinmek istenen kalem yalnız BURADA geçiyor
      newLicenseItemId: otherId,
      reason: 'test: değişim',
      actor: ACTOR,
    });

    await expect(stock.purgeLicenseItem(id, 'olmamalı', ACTOR)).rejects.toThrow(ConflictException);
  });

  it('TEDARİKÇİ FİŞİNDE geçen kalem purge EDİLEMEZ (fiş düz anahtarı taşır)', async () => {
    const product = await createProduct(db, { tag });
    const id = await importOne(product.id, keyOf('CLAIM'));
    await voidIt(id);

    const [supplier] = await db
      .insert(schema.suppliers)
      .values({ name: `IT tedarikçi ${tag}` })
      .returning({ id: schema.suppliers.id });
    const [claim] = await db
      .insert(schema.supplierClaims)
      .values({ code: 'DEG-IT-' + tag, supplierId: supplier!.id, status: 'draft', createdBy: ACTOR })
      .returning({ id: schema.supplierClaims.id });
    await db.insert(schema.supplierClaimItems).values({
      claimId: claim!.id,
      licenseItemId: id,
      productId: product.id,
    });

    await expect(stock.purgeLicenseItem(id, 'olmamalı', ACTOR)).rejects.toThrow(ConflictException);
  });

  /**
   * G6 — parti geri çekmesiyle ölen kalem. AYRIM KRİTİK: kapı parti DURUMUNA değil, kalemi
   * NEYİN öldürdüğüne bakar; yoksa bu özelliğin çözmek için yazıldığı vaka (elle void + sonra
   * parti geri çekme) yanlışlıkla bloklanırdı — 1. test tam da onu kanıtlıyor.
   */
  it('PARTİ GERİ ÇEKMESİYLE ölen kalem purge EDİLEMEZ', async () => {
    const product = await createProduct(db, { tag });
    const id = await importOne(product.id, keyOf('RECALL'));
    await db
      .update(schema.licenseItems)
      .set({ status: 'voided' })
      .where(eq(schema.licenseItems.id, id));
    await db.insert(schema.stockAdjustments).values({
      productId: product.id,
      licenseItemId: id,
      action: 'recall',
      qty: 1,
      reason: 'parti geri çekildi',
      actor: ACTOR,
    });

    await expect(stock.purgeLicenseItem(id, 'olmamalı', ACTOR)).rejects.toThrow(ConflictException);
  });

  it('başarılı purge: satır YOK, İKİ defter satırı DURUYOR, denetim izi düz anahtar TAŞIMAZ', async () => {
    const product = await createProduct(db, { tag });
    const key = keyOf('IZ');
    const id = await importOne(product.id, key);
    await voidIt(id);
    await stock.purgeLicenseItem(id, 'yanlış girildi — kalıcı silindi', ACTOR);

    // 1) Satır gerçekten gitti.
    const rows = await db
      .select({ id: schema.licenseItems.id })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, id));
    expect(rows).toHaveLength(0);

    // 2) Düzeltme defterinde İKİ satır: 'void' (fire qty=1) + 'purge' (qty=0 — zayi İKİ KEZ
    //    sayılmasın diye). İkisi de FK'siz kolon sayesinde silmeden SONRA da ayakta.
    const adj = await db
      .select({ action: schema.stockAdjustments.action, qty: schema.stockAdjustments.qty })
      .from(schema.stockAdjustments)
      .where(eq(schema.stockAdjustments.licenseItemId, id));
    const byAction = Object.fromEntries(adj.map((a) => [a.action, a.qty]));
    expect(byAction.void).toBe(1);
    expect(byAction.purge).toBe(0);

    // 3) Denetim satırı: 'adjust' + meta.op='purge' (yeni enum değeri/migration YOK).
    const audit = await rawAudit(id);
    expect(audit.some((a) => (a.meta as { op?: string })?.op === 'purge')).toBe(true);

    // 4) GİZLİLİK: düz anahtar da payload_hash de meta'ya ASLA yazılmaz.
    const dump = JSON.stringify(audit);
    expect(dump).not.toContain(key);
    expect(dump).not.toContain(crypto.payloadHash(key));
  });

  it('sebep zorunlu ve anlamlı olmalı (boş / 2 karakter reddedilir)', async () => {
    const product = await createProduct(db, { tag });
    const id = await importOne(product.id, keyOf('SEBEP'));
    await voidIt(id);

    await expect(stock.purgeLicenseItem(id, '   ', ACTOR)).rejects.toThrow(BadRequestException);
    // min(3) sınırı controller şemasındadır; servis boş sebebi kendi başına da reddeder.
    const ok = await stock.purgeLicenseItem(id, 'geçerli sebep', ACTOR);
    expect(ok.status).toBe('purged');
  });

  it('olmayan kalem → 404', async () => {
    await expect(stock.purgeLicenseItem(randomUUID(), 'sebep', ACTOR)).rejects.toThrow(
      NotFoundException,
    );
  });
});

/** Kaleme ait denetim satırlarını okur (meta jsonb dâhil). */
async function rawAudit(licenseItemId: string): Promise<Array<{ meta: unknown }>> {
  return db
    .select({ meta: schema.auditLog.meta })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.targetId, licenseItemId));
}
