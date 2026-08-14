import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
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
  insertLicenseItems,
  makeCrypto,
  makeDb,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — tekil lisans MUTASYONLARI (`voidLicenseItem` / `updateLicenseItemPayload`).
 *
 * NEDEN BU DOSYA VAR: iki uç da envanterden TEK bir anahtarı hedefler ve ikisinin de tek
 * güvenlik sınırı "müşterinin elinde canlı lisans var mı?" sorusudur. Bu projede H1 sınıfı
 * regresyon (askıdaki `suspended` atamayı ÖLÜ sayıp anahtarı serbest bırakmak → bedava
 * lisans / müşterinin lisansını sessizce öldürmek) ÜÇ KEZ tekrarladı. Askı bir SON DEĞİL,
 * geri alınabilir bir durumdur: askıdaki anahtar hâlâ o siparişe bağlıdır.
 *
 * Kilitlenen sözleşmeler:
 *   · aktif atamalı kalem  → 409 (asla void/edit edilmez)
 *   · ASKIDAKİ atamalı kalem → 409 (H1 regresyon kilidi — asıl sebep bu)
 *   · available kalem → 'voided' + stock_adjustments defter satırı
 *       (tek kullanımda qty=1; MAK'ta KALAN kapasite → maliyet/zayi doğru)
 *   · updateLicenseItemPayload → payload_hash VE payload_suffix_hash birlikte yeniden
 *       hesaplanır (aksi halde dedupe düşer ve arama eski değeri bulur), mükerrer reddedilir,
 *       yalnız 'available' durumda çalışır.
 */

const tag = randomUUID().slice(0, 8);
const ACTOR = 'panel:it-li-mutations';

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let stock: StockService;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const configFake = { get: () => undefined } as never;
const autocompleteQueueFake = { add: async () => ({ id: 'fake' }) } as never;

/**
 * Kaleme sipariş bağlar ve verilen durumda bir atama yazar (batch-counters.test.ts deseni):
 * gerçek atama motoru burada devrede değil — testin konusu mutasyon guard'ıdır.
 */
async function attachAssignment(
  licenseItemId: string,
  productId: string,
  status: 'active' | 'suspended' | 'replaced' | 'revoked',
): Promise<void> {
  const site = await createSite(db, crypto, { tag });
  const order = await createOrderWithLine(db, {
    siteId: site.id,
    productId,
    qty: 1,
    tag,
  });
  await db
    .update(schema.licenseItems)
    .set({ status: status === 'active' || status === 'suspended' ? 'assigned' : 'quarantined' })
    .where(eq(schema.licenseItems.id, licenseItemId));
  await db.insert(schema.assignments).values({
    orderId: order.orderId,
    lineId: order.lineId,
    licenseItemId,
    units: 1,
    status,
  });
}

describe('tekil lisans iptali ve payload düzenlemesi', () => {
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
    // void/edit + liste görüntülemesi audit_log'a yazar; bu koşuya özel aktörü temizle.
    await db.execute(sql`DELETE FROM audit_log WHERE actor = ${ACTOR}`);
    await cleanupByTag(db, tag);
    await end();
  });

  it('AKTİF atamalı kalem iptal edilemez (409) — teslim edilmiş anahtar asla void olmaz', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const [itemId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      payloadPrefix: 'VOID-ACTIVE',
    });
    await attachAssignment(itemId!, product.id, 'active');

    await expect(stock.voidLicenseItem(itemId!, 'bozuk', ACTOR)).rejects.toBeInstanceOf(
      ConflictException,
    );
    const [row] = await db
      .select({ status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, itemId!));
    expect(row!.status).toBe('assigned');
  });

  it('ASKIDAKİ (suspended) atamalı kalem de iptal edilemez — H1 sınıfı regresyon kilidi', async () => {
    // Askı geri alınabilir: "Geri aç" denince anahtar yeniden müşterinin elinde olur. Askıdaki
    // atamayı ölü sayan her yol (iade/adet-düşür/void) bu projede bedava lisans üretti.
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const [itemId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      payloadPrefix: 'VOID-SUSPENDED',
    });
    await attachAssignment(itemId!, product.id, 'suspended');

    await expect(stock.voidLicenseItem(itemId!, 'bozuk', ACTOR)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('satılabilir kalem iptal edilir: durum voided + defter satırı (tek kullanımda qty=1)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const [itemId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      payloadPrefix: 'VOID-OK',
    });

    const res = await stock.voidLicenseItem(itemId!, 'tedarikçi partisi bozuk', ACTOR);
    expect(res.status).toBe('voided');
    expect(res.qty).toBe(1);

    const [row] = await db
      .select({ status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, itemId!));
    expect(row!.status).toBe('voided');

    // Karantina ekranı SEBEBİ bu defter satırından okur → satır yoksa sebep '—' görünür.
    const adjustments = await db
      .select({
        action: schema.stockAdjustments.action,
        qty: schema.stockAdjustments.qty,
        reason: schema.stockAdjustments.reason,
      })
      .from(schema.stockAdjustments)
      .where(eq(schema.stockAdjustments.licenseItemId, itemId!));
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]!.action).toBe('void');
    expect(adjustments[0]!.qty).toBe(1);
    expect(adjustments[0]!.reason).toBe('tedarikçi partisi bozuk');

    // İkinci iptal denemesi 409 (idempotent değil, DÜRÜST hata).
    await expect(stock.voidLicenseItem(itemId!, 'tekrar', ACTOR)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('MAK/çok kullanımlıkta fire KALAN KAPASİTE kadar yazılır (sabit 1 değil)', async () => {
    // Regresyon: sabit 1 yazmak 500 kullanımlık bir MAK anahtarının zayiini 1 birim gösterir →
    // maliyet/zayi raporu ve tedarikçi karnesi yanlış olur.
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'multi',
      maxUses: 500,
    });
    const [itemId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      maxUses: 500,
      payloadPrefix: 'VOID-MAK',
    });
    // 3 kullanım satılmış → kalan kapasite 497.
    await db
      .update(schema.licenseItems)
      .set({ useCount: 3 })
      .where(eq(schema.licenseItems.id, itemId!));

    const res = await stock.voidLicenseItem(itemId!, 'MAK bozuk', ACTOR);
    expect(res.qty).toBe(497);

    const adjustments = await db
      .select({ qty: schema.stockAdjustments.qty })
      .from(schema.stockAdjustments)
      .where(eq(schema.stockAdjustments.licenseItemId, itemId!));
    expect(adjustments[0]!.qty).toBe(497);
  });

  it('payload düzenlemesi: hash VE suffix hash birlikte yeniden hesaplanır', async () => {
    // Regresyon: yalnız payload_enc güncellenirse (a) dedupe eski değere göre çalışır ve aynı
    // anahtar ikinci kez girilebilir, (b) arama ESKİ değeri bulur, YENİSİNİ bulamaz — ikisi de
    // sessiz kusurdur. Doğrulamayı hash kolonlarını okuyarak DEĞİL, gerçek arama yoluyla da yapıyoruz.
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const OLD = `DUZENLE-${tag.toUpperCase()}-ESKI-ZXQVW`;
    const NEW = `DUZENLE-${tag.toUpperCase()}-YENI-WVQXZ`;
    await stock.import(product.id, [{ payload: OLD }], undefined, false, ACTOR);
    const page = await stock.listLicenseItems({ productId: product.id, pageSize: 100 }, ACTOR, true);
    const itemId = page.rows.find((r) => r.value === OLD)!.id;

    const res = await stock.updateLicenseItemPayload(itemId, { value: NEW, reason: 'yanlış girilmiş' }, ACTOR);
    expect(res.changed).toBe(true);
    expect(res.value).toBe(NEW);

    const [stored] = await db
      .select({
        payloadHash: schema.licenseItems.payloadHash,
        suffixHash: schema.licenseItems.payloadSuffixHash,
      })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, itemId));
    expect(stored!.payloadHash).toBe(crypto.payloadHash(NEW));
    expect(stored!.suffixHash).toBe(crypto.payloadSuffixHash(NEW));

    // Arama ekseni: yeni değer bulunur, eski değer artık bulunmaz.
    const foundNew = await stock.listLicenseItems({ search: NEW, pageSize: 100 }, ACTOR, true);
    expect(foundNew.rows.map((r) => r.id)).toContain(itemId);
    const foundOld = await stock.listLicenseItems({ search: OLD, pageSize: 100 }, ACTOR, true);
    expect(foundOld.rows.map((r) => r.id)).not.toContain(itemId);
  });

  it('mükerrer payload düzenlemesi reddedilir (409, ham UNIQUE ihlali sızmaz)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const A = `MUKERRER-${tag.toUpperCase()}-A`;
    const B = `MUKERRER-${tag.toUpperCase()}-B`;
    await stock.import(product.id, [{ payload: A }, { payload: B }], undefined, false, ACTOR);
    const page = await stock.listLicenseItems({ productId: product.id, pageSize: 100 }, ACTOR, true);
    const idB = page.rows.find((r) => r.value === B)!.id;

    await expect(
      stock.updateLicenseItemPayload(idB, { value: A, reason: 'yanlışlıkla' }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);

    // B DEĞİŞMEDEN kaldı (kısmi yazım yok).
    const after = await stock.listLicenseItems({ productId: product.id, pageSize: 100 }, ACTOR, true);
    expect(after.rows.find((r) => r.id === idB)!.value).toBe(B);
  });

  it('teslim edilmiş (askıdaki dahil) ve satılabilir olmayan kalem DÜZENLENEMEZ', async () => {
    // Teslim edilmiş anahtarın değişimi envanterin işi DEĞİLDİR (assignment replace akışı):
    // buradan düzenlenirse müşterinin elindeki anahtar sessizce geçersizleşirdi.
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const [suspendedId, voidedId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 2,
      tag,
      payloadPrefix: 'EDIT-GUARD',
    });
    await attachAssignment(suspendedId!, product.id, 'suspended');
    await stock.voidLicenseItem(voidedId!, 'düşüldü', ACTOR);

    await expect(
      stock.updateLicenseItemPayload(suspendedId!, { value: 'YENI-DEGER-1', reason: 'x' }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      stock.updateLicenseItemPayload(voidedId!, { value: 'YENI-DEGER-2', reason: 'x' }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
