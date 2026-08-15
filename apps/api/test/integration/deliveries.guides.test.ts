import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { OrdersService } from '../../src/orders/orders.service';
import type { Database } from '../../src/db/db.module';
import type { Site } from '../../src/db/schema';
import * as schema from '../../src/db/schema';
import {
  cleanupByTag,
  createOrderWithLine,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  tagPrefix,
  type Db,
} from './_helpers';
import type { CryptoService } from '../../src/crypto/crypto.service';

/**
 * ENTEGRASYON — §7 kurulum/etkinleştirme rehberinin TESLİMAT yanıtına taşınması (gerçek PG).
 *
 * Bu yol testsizdi: rehber müşteriye giden üç yüzeyin (mağaza sayfası, e-posta, .txt) ortak
 * kaynağıdır ve sessizce kaybolması ancak müşteri şikâyetiyle fark edilirdi.
 *
 * Kilitlenen davranışlar:
 *   1. rehberli ürün → yanıtta `guides` dolu, kalem `guideId` ile ona bağlı, HTML render edilmiş,
 *   2. rehbersiz ürün → `guides` BOŞ (yer tutucu/boş kutu üretilmez),
 *   3. AYNI rehbere bağlı çok kalemli sipariş → rehber TEK KEZ döner (gövde tekrarlanmaz),
 *   4. iptal (canceled) satırın rehberi yanıta GİRMEZ,
 *   5. rehber silinince ürün ayakta kalır ve teslimat rehbersiz sürer (ON DELETE SET NULL).
 *
 * Nest ayağa kaldırılmaz: getDeliveries yalnız this.db + this.crypto kullanır (kardeş
 * deliveries.expiry-filter testinin deseni) → kalan bağımlılıklar güvenli stub.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let svc: OrdersService;
let siteId: string;

const GUIDE_BODY = [
  'Ofis 365 kullanmak icin asagidaki adimlari izleyin.',
  '',
  '1. https://www.office.com adresine gidin.',
  '2. **Parolanizi** guncelleyin.',
].join('\n');

/** Rehber kaydı açar (başlık tag'li → cleanupByTag temizler). */
async function createGuide(title: string, body = GUIDE_BODY): Promise<string> {
  const [row] = await db
    .insert(schema.productGuides)
    .values({ title: `${tagPrefix(tag)}-${title}`, body })
    .returning({ id: schema.productGuides.id });
  return row!.id;
}

/** Ürüne rehber bağlar (createProduct helper'ı guideId almıyor — sözleşmesi değiştirilmedi). */
async function attachGuide(productId: string, guideId: string | null): Promise<void> {
  await db.update(schema.products).set({ guideId }).where(eq(schema.products.id, productId));
}

/** Ürün + stok + sipariş + AKTİF atama kurar; teslimat yanıtını döndürür. */
async function deliver(opts: { guideId?: string | null; cancelLine?: boolean }) {
  const product = await createProduct(db, { tag });
  if (opts.guideId !== undefined) await attachGuide(product.id, opts.guideId);
  const [itemId] = await insertLicenseItems(db, crypto, {
    productId: product.id,
    count: 1,
    tag,
    status: 'assigned',
  });
  const order = await createOrderWithLine(db, { siteId, productId: product.id, qty: 1, tag });
  await db.insert(schema.assignments).values({
    orderId: order.orderId,
    lineId: order.lineId,
    licenseItemId: itemId!,
    status: 'active',
    units: 1,
    validUntil: null,
  });
  if (opts.cancelLine) {
    await db
      .update(schema.orderLines)
      .set({ canceled: true })
      .where(eq(schema.orderLines.id, order.lineId));
  }
  const res = await svc.getDeliveries({ id: siteId } as unknown as Site, order.orderId);
  return { res, order, product };
}

describe('OrdersService.getDeliveries — kurulum rehberi (§7)', () => {
  beforeAll(async () => {
    const h = makeDb();
    db = h.db;
    end = h.end;
    crypto = makeCrypto();
    svc = new OrdersService(
      db as unknown as Database,
      {} as never,
      crypto as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const site = await createSite(db, crypto, { tag });
    siteId = site.id;
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('rehberli ürün → guides dolu, kalem guideId ile bağlı, HTML render edilmiş', async () => {
    const guideId = await createGuide('office365');
    const { res } = await deliver({ guideId });

    expect(res.guides).toHaveLength(1);
    expect(res.guides![0]!.id).toBe(guideId);
    // Render PANELDE yapılır (eklenti ikinci ayrıştırıcı taşımaz) → HTML hazır gelmeli.
    expect(res.guides![0]!.html).toContain('<ol>');
    expect(res.guides![0]!.html).toContain('<strong>Parolanizi</strong>');
    expect(res.guides![0]!.html).toContain('href="https://www.office.com"');
    // Düz metin sürümü .txt indirme + e-posta içindir; biçim işaretleri temizlenmiş olmalı.
    expect(res.guides![0]!.text).toContain('1. https://www.office.com');
    expect(res.guides![0]!.text).not.toContain('**');
    // Kalem rehbere KİMLİKLE bağlanır (gövde kalemde TAŞINMAZ — 50 anahtarlı siparişte
    // metni 50 kez göndermek bu ucu gereksiz yorardı).
    expect(res.deliveries[0]!.guideId).toBe(guideId);
  });

  it('rehbersiz ürün → guides BOŞ (boş kutu/yer tutucu üretilmez)', async () => {
    const { res } = await deliver({ guideId: null });
    expect(res.guides).toEqual([]);
    expect(res.deliveries[0]!.guideId).toBeNull();
  });

  it('aynı rehbere bağlı iki kalem → rehber TEK KEZ döner', async () => {
    const guideId = await createGuide('paylasimli');
    const p1 = await createProduct(db, { tag });
    const p2 = await createProduct(db, { tag });
    await attachGuide(p1.id, guideId);
    await attachGuide(p2.id, guideId);

    const order = await createOrderWithLine(db, { siteId, productId: p1.id, qty: 1, tag });
    // İkinci kalem AYNI siparişe eklenir (aynı rehbere bağlı farklı ürün).
    await db.insert(schema.orderLines).values({
      orderId: order.orderId,
      productId: p2.id,
      remoteLineId: `${tagPrefix(tag)}-line2-${randomUUID().slice(0, 8)}`,
      qty: 1,
    });

    const res = await svc.getDeliveries({ id: siteId } as unknown as Site, order.orderId);
    expect(res.guides).toHaveLength(1);
    expect(res.guides![0]!.id).toBe(guideId);
  });

  it('iptal (canceled) satırın rehberi yanıta GİRMEZ', async () => {
    const guideId = await createGuide('iptal');
    const { res } = await deliver({ guideId, cancelLine: true });
    // İptal satırın ataması zaten filtrelenir; rehber de aynı yüklemi izlemeli, yoksa
    // müşteri hiç teslim edilmemiş bir ürünün kurulum talimatını görürdü.
    expect(res.deliveries).toHaveLength(0);
    expect(res.guides).toEqual([]);
  });

  it('rehber silinince ürün AYAKTA kalır, teslimat rehbersiz sürer (SET NULL)', async () => {
    const guideId = await createGuide('silinecek');
    const product = await createProduct(db, { tag });
    await attachGuide(product.id, guideId);
    const [itemId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      status: 'assigned',
    });
    const order = await createOrderWithLine(db, { siteId, productId: product.id, qty: 1, tag });
    await db.insert(schema.assignments).values({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: itemId!,
      status: 'active',
      units: 1,
      validUntil: null,
    });

    await db.delete(schema.productGuides).where(eq(schema.productGuides.id, guideId));

    const [stillThere] = await db
      .select({ id: schema.products.id, guideId: schema.products.guideId })
      .from(schema.products)
      .where(eq(schema.products.id, product.id));
    expect(stillThere).toBeDefined(); // ürün SİLİNMEDİ
    expect(stillThere!.guideId).toBeNull(); // yalnız bağ koptu

    const res = await svc.getDeliveries({ id: siteId } as unknown as Site, order.orderId);
    expect(res.deliveries).toHaveLength(1); // teslimat etkilenmedi
    expect(res.guides).toEqual([]);
  });
});
