import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { serializeAccountPayload } from '@lisans/shared';
import * as schema from '../../src/db/schema';
import { StockService } from '../../src/stock/stock.service';
import { ProductsService } from '../../src/products/products.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { CryptoService } from '../../src/crypto/crypto.service';
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
 * ENTEGRASYON — TESLİM EDİLMİŞ hesabın kimlik bilgisi güncellemesi (`rotateAccountCredentials`).
 *
 * NEDEN BU UÇ VAR: hesap ürününde sağlayıcı tarafında parola değişebilir. Panelin diğer iki
 * aracı bu durumda YANLIŞ sonuç verir ve ikisi de bilinçlidir:
 *   · `updateLicenseItemPayload` teslim edilmiş kalemi 409'lar (müşterinin gördüğü değerle
 *     DB'yi sessizce ayırmamak için),
 *   · "Değiştir" (replace) BAŞKA bir hesap atar → eski hesap müşterinin elinde ÇALIŞMAYA
 *     devam eder (kimlik bilgilerini kopyalamıştır) ve müşterinin o hesaptaki verisi kaybolur.
 * Yani anahtar ürününde doğru olan çözüm hesap ürününde yanlıştır; bu uç aradaki boşluktur:
 * AYNI kalem, AYNI atama, YENİ kimlik bilgileri.
 *
 * Kilitlenen sözleşmeler:
 *   · yalnız `kind='account'` (anahtar ürünü → 400, replace akışına yönlendirir)
 *   · yalnız CANLI ataması olan kalem (teslim edilmemişte normal düzenleme yolu çalışır → 409)
 *   · payload GERÇEKTEN değişir ve AAD (`license_item:<id>`) korunarak yeniden şifrelenir
 *   · `payload_hash` yenilenir (dedupe düşmesin), hesapta `payload_suffix_hash` NULL kalır
 *   · maskeli değer REDDEDİLİR (owner-olmayanın maskeli formu kaydetmesi lisansı imha ederdi)
 *   · sipariş zaman çizelgesine GÖRÜNÜR olay + audit yazılır (sır NOTA GİRMEZ)
 */

const tag = randomUUID().slice(0, 8);
const ACTOR = 'panel:it-acct-rotate';

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let stock: StockService;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const configFake = { get: () => undefined } as never;
const autocompleteQueueFake = { add: async () => ({ id: 'fake' }) } as never;

const SCHEMA = [
  { key: 'username', label: 'Kullanıcı adı', secret: false, required: true },
  { key: 'password', label: 'Parola', secret: true, required: true },
];

/** Hesap kalemini şifreli olarak yazar (import yolunun ürettiğiyle aynı biçim). */
async function insertAccountItem(
  productId: string,
  fields: Record<string, string>,
): Promise<{ id: string; plaintext: string }> {
  const id = randomUUID();
  const plaintext = serializeAccountPayload(SCHEMA as never, fields);
  await db.insert(schema.licenseItems).values({
    id,
    productId,
    payloadEnc: crypto.encrypt(plaintext, CryptoService.licenseItemAad(id)),
    payloadHash: crypto.payloadHash(plaintext),
    // Hesap ürününde son-5 hash'i YAZILMAZ (kanonik JSON'un kuyruğu aranabilir değildir).
    payloadSuffixHash: null,
    maxUses: 1,
    status: 'available',
  });
  return { id, plaintext };
}

/** Kaleme canlı bir atama bağlar (gerçek atama motoru testin konusu değil). */
async function deliver(licenseItemId: string, productId: string): Promise<string> {
  const site = await createSite(db, crypto, { tag });
  const order = await createOrderWithLine(db, { siteId: site.id, productId, qty: 1, tag });
  await db
    .update(schema.licenseItems)
    .set({ status: 'assigned' })
    .where(eq(schema.licenseItems.id, licenseItemId));
  await db.insert(schema.assignments).values({
    orderId: order.orderId,
    lineId: order.lineId,
    licenseItemId,
    units: 1,
    status: 'active',
  });
  return order.orderId;
}

describe('teslim edilmiş hesabın kimlik bilgisi güncellemesi', () => {
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

  it('(a) teslim edilmiş hesabın parolası YERİNDE güncellenir; atama ve kalem AYNI kalır', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'account',
      usageMode: 'single',
      payloadSchema: SCHEMA,
    });
    const { id, plaintext: before } = await insertAccountItem(product.id, {
      username: 'ofis@ornek.com',
      password: 'EskiParola1',
    });
    const orderId = await deliver(id, product.id);

    const res = await stock.rotateAccountCredentials(
      id,
      {
        fields: { username: 'ofis@ornek.com', password: 'YeniParola2' },
        reason: 'Sağlayıcı parolayı döndürdü',
      },
      ACTOR,
    );

    expect(res.liveAssignments).toBe(1);
    expect(res.orderIds).toContain(orderId);

    // Kalem AYNI satır, payload GERÇEKTEN değişti ve AAD korunarak çözülebiliyor.
    const [row] = await db
      .select()
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, id));
    expect(row!.payloadEnc).not.toBe(before);
    expect(crypto.decrypt(row!.payloadEnc, CryptoService.licenseItemAad(id))).toContain(
      'YeniParola2',
    );
    // Dedupe alanı YENİ düz metne göre yenilendi (aksi halde aynı kimlik bilgisi ikinci kez
    // stoğa girebilir); hesapta son-5 hash'i NULL kalır (kanonik JSON kuyruğu aranabilir değil).
    const after = crypto.decrypt(row!.payloadEnc, CryptoService.licenseItemAad(id));
    expect(row!.payloadHash).toBe(crypto.payloadHash(after));
    expect(row!.payloadSuffixHash).toBeNull();
    // Atama DOKUNULMADI (müşteri aynı lisansa sahip, yeni anahtar YANMADI).
    const asg = await db
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.licenseItemId, id));
    expect(asg).toHaveLength(1);
    expect(asg[0]!.status).toBe('active');

    // Sipariş zaman çizelgesinde GÖRÜNÜR iz var ve sır NOTA GİRMEMİŞ.
    const events = await db
      .select()
      .from(schema.fulfillmentEvents)
      .where(eq(schema.fulfillmentEvents.orderId, orderId));
    const rotated = events.find((e) => e.type === 'account_credentials_rotated');
    expect(rotated).toBeTruthy();
    expect(rotated!.message).toContain('Sağlayıcı parolayı döndürdü');
    expect(rotated!.message).not.toContain('YeniParola2');
  });

  it('(b) anahtar ürününde REDDEDİLİR — değişen anahtar ayrı bir lisanstır (replace akışı)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const id = randomUUID();
    const plaintext = `ROT-KEY-${tag}-1`;
    await db.insert(schema.licenseItems).values({
      id,
      productId: product.id,
      payloadEnc: crypto.encrypt(plaintext, CryptoService.licenseItemAad(id)),
      payloadHash: crypto.payloadHash(plaintext),
      payloadSuffixHash: crypto.payloadSuffixHash(plaintext),
      maxUses: 1,
      status: 'available',
    });
    await deliver(id, product.id);

    await expect(
      stock.rotateAccountCredentials(id, { fields: { a: 'b' }, reason: 'deneme' }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('(c) CANLI teslimatı olmayan kalem REDDEDİLİR — normal düzenleme yolu kullanılmalı', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'account',
      usageMode: 'single',
      payloadSchema: SCHEMA,
    });
    const { id } = await insertAccountItem(product.id, {
      username: 'bos@ornek.com',
      password: 'Parola1',
    });

    await expect(
      stock.rotateAccountCredentials(
        id,
        { fields: { username: 'bos@ornek.com', password: 'Parola2' }, reason: 'deneme' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('(d) MASKELİ değer reddedilir — owner-olmayanın formu lisansı sessizce imha edemez', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'account',
      usageMode: 'single',
      payloadSchema: SCHEMA,
    });
    const { id, plaintext: before } = await insertAccountItem(product.id, {
      username: 'maske@ornek.com',
      password: 'GercekParola1',
    });
    await deliver(id, product.id);

    await expect(
      stock.rotateAccountCredentials(
        id,
        { fields: { username: 'maske@ornek.com', password: '••••••' }, reason: 'deneme' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Payload'a DOKUNULMAMIŞ olmalı (reddedilen istek yazmaz).
    const [row] = await db
      .select()
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, id));
    expect(crypto.decrypt(row!.payloadEnc, CryptoService.licenseItemAad(id))).toBe(before);
  });

  it('(e) sebep zorunlu — denetim izi gerekçesiz kalmaz', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'account',
      usageMode: 'single',
      payloadSchema: SCHEMA,
    });
    const { id } = await insertAccountItem(product.id, {
      username: 'sebep@ornek.com',
      password: 'Parola1',
    });
    await deliver(id, product.id);

    await expect(
      stock.rotateAccountCredentials(
        id,
        { fields: { username: 'sebep@ornek.com', password: 'Parola2' }, reason: '  ' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
