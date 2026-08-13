import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import type { Site } from '../../src/db/schema';
import { StockService } from '../../src/stock/stock.service';
import { OrdersService } from '../../src/orders/orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { ProductsService } from '../../src/products/products.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createOrderWithLine,
  createProduct,
  createSite,
  makeCrypto,
  makeDb,
  type CreatedSite,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — hesap (account) payload NORMALİZASYONU (§12, `serializeAccountPayload`).
 *
 * Neden kritik: operatör hesap bilgilerini elektronik tablodan / web sayfasından
 * YAPIŞTIRIR. Bu değerler görünmez karakter taşır (sondaki boşluk, kırılmaz boşluk,
 * BOM, sıfır-genişlik, otomatik düzeltmenin ürettiği "akıllı" tırnak). İki ayrı hasar:
 *   1. Müşteriye YANLIŞ PAROLA teslim edilir (kopyalanan değer olduğu gibi giriş yapmaz),
 *   2. `payload_hash` sapar → dedupe çalışmaz → aynı hesap İKİ müşteriye satılabilir.
 *
 * Ayrıca şemada OLMAYAN anahtar (elektronik tablo başlığı 'Password' ↔ şema 'password')
 * SESSİZCE ATILMAZ: eskiden alan düşüyor ve PAROLASIZ hesap teslim ediliyordu.
 *
 * Doğrulanan uçtan uca yol: import → şifreli kayıt → atama → getDeliveries (müşterinin
 * GERÇEKTEN gördüğü değer) + owner-olmayan admin listesindeki maskeleme.
 *
 * NOT (bilinçli): kirli girdiler kaynak dosyaya GÖRÜNMEZ karakter olarak gömülmez —
 * aşağıdaki adlandırılmış kaçış sabitlerinden kurulur. Aksi halde bir editör/biçimlendirici
 * karakteri sessizce kırpar ve test "yeşil" kalırken hiçbir şey doğrulamaz.
 */

/** Byte order mark — bazı dışa aktarımlar hücre/dosya başına ekler. */
const BOM = '﻿';
/** Kırılmaz boşluk — normal boşluktan gözle ayırt edilemez. */
const NBSP = ' ';
/** Sıfır-genişlik boşluk — tamamen görünmez, kopyala-yapıştırla bulaşır. */
const ZWSP = '​';
/** Akıllı (kıvrık) tek tırnak — ofis otomatik düzeltmesi parolayı böyle bozar. */
const RSQUO = '’';

const tag = randomUUID().slice(0, 8);
const ACTOR = 'panel:it-account';

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let products: ProductsService;
let stock: StockService;
let orders: OrdersService;
let site: CreatedSite;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;
const securityFake = {
  recordQuotaExceeded: async () => false,
  recordQuotaHeld: async () => false,
} as never;
const configFake = { get: () => undefined } as never;
const autocompleteQueueFake = { add: async () => ({ id: 'fake' }) } as never;

/** username (açık) + password (secret) — iki alanlı standart hesap şeması. */
const ACCOUNT_SCHEMA = [
  { key: 'username', label: 'Kullanıcı adı', secret: false, required: true },
  { key: 'password', label: 'Parola', secret: true, required: true },
];

const accountProduct = () =>
  createProduct(db, {
    tag,
    kind: 'account',
    usageMode: 'single',
    fulfillmentPolicy: 'partial-auto',
    payloadSchema: ACCOUNT_SCHEMA,
  });

async function itemCount(productId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.licenseItems.id })
    .from(schema.licenseItems)
    .where(eq(schema.licenseItems.productId, productId));
  return rows.length;
}

describe('StockService.import — hesap payload normalizasyonu (görünmez karakter + bilinmeyen alan)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    products = new ProductsService(db as never);
    const fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    const admin = new AdminOrdersService(db as never, redisFake, crypto, mailFake, fulfillment);
    stock = new StockService(
      db as never,
      crypto,
      products,
      fulfillment,
      configFake,
      autocompleteQueueFake,
    );
    orders = new OrdersService(
      db as never,
      products,
      crypto,
      mailFake,
      webhookFake,
      fulfillment,
      admin,
      securityFake,
    );
    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('(14) yapıştırma kirliliği (BOM/NBSP/akıllı tırnak/sıfır-genişlik) → müşteriye TAM TEMİZ değer teslim edilir', async () => {
    const product = await accountProduct();
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
      status: 'pending',
    });

    const CLEAN_USER = `kullanici-${tag} yedek`;
    const CLEAN_PASS = `Pa'rola-${tag}`;
    // BOM (baş) + NBSP (orta, normal boşluğa dönmeli) + sondaki boşluklar.
    const DIRTY_USER = `${BOM}kullanici-${tag}${NBSP}yedek   `;
    // Baştaki boşluk + akıllı tırnak (düz tırnağa dönmeli) + sıfır-genişlik + sondaki boşluk.
    const DIRTY_PASS = `  Pa${RSQUO}rola-${tag}${ZWSP} `;
    // Ön koşul: girdiler gerçekten "kirli" — aksi halde test hiçbir şey kanıtlamaz.
    expect(DIRTY_USER).not.toBe(CLEAN_USER);
    expect(DIRTY_PASS).not.toBe(CLEAN_PASS);

    const res = await stock.import(
      product.id,
      [{ payload: { username: DIRTY_USER, password: DIRTY_PASS } }],
      undefined,
      false,
      ACTOR,
    );
    expect(res.imported).toBe(1);
    expect(res.rejected).toBe(0);
    expect(res.autoCompleted).toBeGreaterThanOrEqual(1);

    // Müşterinin GERÇEKTEN gördüğü değer (envelope çözümü + alan render'ı dâhil).
    const deliv = await orders.getDeliveries(
      { id: site.id, domain: site.domain } as unknown as Site,
      order.orderId,
    );
    expect(deliv.deliveries).toHaveLength(1);
    const delivered = deliv.deliveries[0]!;
    expect(delivered.kind).toBe('account');
    expect(delivered.payload).toBeNull();

    const fields = delivered.fields ?? [];
    const user = fields.find((f) => f.key === 'username');
    const pass = fields.find((f) => f.key === 'password');
    expect(user?.value).toBe(CLEAN_USER);
    // Parola BİREBİR temiz olmalı — tek bir görünmez karakter girişi başarısız yapar.
    expect(pass?.value).toBe(CLEAN_PASS);
    expect(pass?.secret).toBe(true);
  });

  it('(15) aynı hesap, biri kopyalama artığı boşluklu → normalize sonrası AYNI hash → dedupe tutar', async () => {
    const product = await accountProduct();
    const username = `dedupe-${tag}`;
    const password = `Sifre-${tag}-9`;

    const res = await stock.import(
      product.id,
      [
        { payload: { username, password } },
        // Aynı hesap; yalnız görünmez artıklar farklı (NBSP + sondaki boşluk).
        { payload: { username: `${username}${NBSP}`, password: ` ${password}  ` } },
      ],
      undefined,
      false,
      ACTOR,
    );

    expect(res.requested).toBe(2);
    expect(res.rejected).toBe(0);
    expect(res.imported).toBe(1);
    // Normalize edilmeseydi iki AYRI hash oluşur, aynı hesap İKİ müşteriye satılabilirdi.
    expect(res.duplicates).toBe(1);
    expect(await itemCount(product.id)).toBe(1);
  });

  it("(16) şemada olmayan anahtar ('Password' ≠ 'password') → satır REDDEDİLİR; sebep DEĞERİ taşımaz", async () => {
    const product = await accountProduct();
    const SECRET_VALUE = `CokGizliParola-${tag}-42`;

    const res = await stock.import(
      product.id,
      [{ payload: { username: `u-${tag}`, Password: SECRET_VALUE } }],
      undefined,
      false,
      ACTOR,
    );

    // Sessiz atma YOK: eskiden 'Password' düşüyor ve PAROLASIZ hesap teslim ediliyordu.
    expect(res.imported).toBe(0);
    expect(res.rejected).toBe(1);
    expect(res.rejections).toHaveLength(1);
    expect(res.rejections[0]!.index).toBe(0);

    const reason = res.rejections[0]!.reason;
    // Operatörün düzeltebilmesi için anahtar ADI gerekli…
    expect(reason).toContain('Password');
    // …ama sır ASLA hata metnine girmez (§8: log/hata/istisna metni payload taşımaz).
    expect(reason).not.toContain(SECRET_VALUE);
    expect(reason).not.toContain('CokGizli');

    expect(await itemCount(product.id)).toBe(0);
  });

  it('(17) yalnız görünmez boşluktan ibaret zorunlu alan → BOŞ sayılır, satır reddedilir', async () => {
    const product = await accountProduct();

    const res = await stock.import(
      product.id,
      [{ payload: { username: `u-${tag}`, password: `  ${NBSP}${ZWSP} ` } }],
      undefined,
      false,
      ACTOR,
    );

    expect(res.imported).toBe(0);
    expect(res.rejected).toBe(1);
    expect(res.rejections[0]!.reason).toContain('password');
    // Boş parolalı hesap ASLA kalıcı olmaz (müşteriye kullanılamaz lisans gitmez).
    expect(await itemCount(product.id)).toBe(0);
  });

  it('(18) normalize edilen secret alan maskeleme yolunda bozulmaz (owner düz, owner-olmayan maskeli)', async () => {
    const product = await accountProduct();
    const CLEAN_USER = `mask-user-${tag}`;
    const CLEAN_PASS = `MaskPass-${tag}-77`;

    const res = await stock.import(
      product.id,
      // Yine kirli yapıştırma: maskeleme yolunun NORMALİZE EDİLMİŞ değeri kullandığını gösterir.
      [{ payload: { username: `${CLEAN_USER}${NBSP}`, password: `${BOM}${CLEAN_PASS} ` } }],
      undefined,
      false,
      ACTOR,
    );
    expect(res.imported).toBe(1);

    // reveal=true (owner): düz metin — normalize edilmiş TEMİZ değer.
    const revealed = await stock.listLicenseItems({ productId: product.id }, ACTOR, true);
    expect(revealed.rows).toHaveLength(1);
    const openFields = revealed.rows[0]!.fields ?? [];
    expect(openFields.find((f) => f.key === 'username')?.value).toBe(CLEAN_USER);
    expect(openFields.find((f) => f.key === 'password')?.value).toBe(CLEAN_PASS);

    // reveal=false (owner-olmayan 'admin', A1): secret alan KUYRUKSUZ maskelenir.
    const masked = await stock.listLicenseItems({ productId: product.id }, ACTOR, false);
    expect(masked.rows).toHaveLength(1);
    const maskedFields = masked.rows[0]!.fields ?? [];
    const maskedPass = maskedFields.find((f) => f.key === 'password');
    expect(maskedPass).toBeDefined();
    expect(maskedPass!.value).not.toBe(CLEAN_PASS);
    // Kuyruksuz maske: parolanın son 4 hanesi bile sızmaz (key maskesinden FARKLI).
    expect(maskedPass!.value).not.toContain(CLEAN_PASS.slice(-4));
    expect(maskedPass!.value).not.toContain(tag);
    // secret OLMAYAN alan maskelenmez ve normalize edilmiş hâlini korur.
    expect(maskedFields.find((f) => f.key === 'username')?.value).toBe(CLEAN_USER);
  });
});
