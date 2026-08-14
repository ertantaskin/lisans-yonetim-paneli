import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  serializeAccountPayload,
  type AccountPayloadSchema,
  type CreateOrderRequest,
} from '@lisans/shared';
import { CryptoService } from '../../src/crypto/crypto.service';
import { OrdersService } from '../../src/orders/orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { ProductsService } from '../../src/products/products.service';
import * as schema from '../../src/db/schema';
import { assignments, licenseItems, orderLines, type Site } from '../../src/db/schema';
import {
  cleanupByTag,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  makeDb,
} from './_helpers';

/**
 * ENTEGRASYON — KARIŞIK ÜRÜN TİPLİ TEK SİPARİŞ (key + MAK/multi + account).
 *
 * NEDEN: gerçek mağaza siparişi tam olarak budur (bir sepette Windows key + MAK toplu lisans +
 * hesap ürünü), ama hiçbir test tek siparişte birden çok ÜRÜN TİPİ kurmuyordu. Tipe göre dallanan
 * üç ayrı mekanizma (tek-kullanımlık satır atama · MAK kapasite düşümü · hesap alan-alan render)
 * yalnız KENDİ dosyalarında, izole olarak doğrulanıyordu — biri diğerinin satırını yanlış ölçekte
 * hesaplasa hiçbir test görmezdi.
 *
 * Ayrıca burada `validity_days` → `assignments.valid_until` TÜRETİMİ ilk kez doğrulanır: mevcut
 * testlerin hepsi `validUntil`i ELLE enjekte ediyordu (deliveries.expiry-filter), yani "teslimat
 * anından itibaren N gün" kuralının kendisi hiç koşulmuyordu. Test SABİT TARİH VARSAYMAZ:
 * beklenen değer, sipariş oluşturmadan hemen önce alınan damgaya göre tolerans penceresiyle ölçülür.
 *
 * Fixture beforeAll'da BİR KEZ kurulur (tek sipariş), testler onun üzerinde ayrı boyutları doğrular.
 */

const TAG = randomUUID().slice(0, 8);
const VALIDITY_DAYS = 365;
const DAY_MS = 86_400_000;

const { db, end } = makeDb();
const crypto = makeCrypto();

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;

const productsService = new ProductsService(db as never);
const fulfillmentService = new FulfillmentService(
  db as never,
  productsService,
  mailFake,
  webhookFake,
);
const adminOrdersService = new AdminOrdersService(
  db as never,
  redisFake,
  crypto,
  mailFake,
  fulfillmentService,
);
const orders = new OrdersService(
  db as never,
  productsService,
  crypto,
  mailFake,
  webhookFake,
  fulfillmentService,
  adminOrdersService,
  { recordQuotaExceeded: async () => false, recordQuotaHeld: async () => false } as never,
);

/** Hesap ürünü alan tanımları — `username` açık, `password` secret (admin yüzeyinde maskelenir). */
const ACCOUNT_SCHEMA: AccountPayloadSchema = [
  { key: 'username', label: 'Kullanıcı adı', secret: false, required: true },
  { key: 'password', label: 'Parola', secret: true, required: true },
];
const ACCOUNT_VALUES = { username: `kullanici-${TAG}`, password: `Parola!${TAG}` };

/**
 * Hesap tipli license_item ekler. `insertLicenseItems` düz metin üretir; hesap ürününde
 * payload KANONİK JSON olmak zorundadır (dedupe + alan çözümü buna dayanır) → import yolunun
 * kullandığı `serializeAccountPayload` ile birebir aynı şekilde kurulur.
 * (Yardımcı burada YEREL: `_helpers.ts` paylaşılan dosyadır, paralel işçilerle çakışmamak için
 * değiştirilmedi.)
 */
async function insertAccountItem(productId: string): Promise<{ id: string; plaintext: string }> {
  const id = randomUUID();
  const plaintext = serializeAccountPayload(ACCOUNT_SCHEMA, ACCOUNT_VALUES);
  await db.insert(schema.licenseItems).values({
    id,
    productId,
    payloadEnc: crypto.encrypt(plaintext, CryptoService.licenseItemAad(id)),
    payloadHash: crypto.payloadHash(plaintext),
    payloadSuffixHash: crypto.payloadSuffixHash(plaintext),
    status: 'available',
    maxUses: 1,
  });
  return { id, plaintext };
}

interface Fixture {
  site: Site;
  orderId: string;
  httpStatus: number;
  keyProductId: string;
  makProductId: string;
  accountProductId: string;
  accountItemId: string;
  /** createOrder çağrısından hemen ÖNCEKİ damga — valid_until toleransının referansı. */
  beforeCreateMs: number;
}
let fx: Fixture;

describe('Karışık ürün tipli tek sipariş (key + MAK + account)', () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL tanımlı değil — entegrasyon testleri gerçek PostgreSQL gerektirir.',
      );
    }
    const site = await createSite(db, crypto, { tag: TAG });

    // (1) Tek kullanımlık key ürünü — 2 adet stok, 2 adet istenecek.
    const keyProduct = await createProduct(db, { tag: TAG, kind: 'key', usageMode: 'single' });
    await insertLicenseItems(db, crypto, {
      productId: keyProduct.id,
      count: 2,
      tag: TAG,
      payloadPrefix: 'SINGLEKEY',
    });

    // (2) MAK/çok kullanımlık — 1 anahtar × 5 kullanım, 3 birim istenecek.
    const makProduct = await createProduct(db, {
      tag: TAG,
      kind: 'key',
      usageMode: 'multi',
      maxUses: 5,
    });
    await insertLicenseItems(db, crypto, {
      productId: makProduct.id,
      count: 1,
      tag: TAG,
      maxUses: 5,
      payloadPrefix: 'MAKKEY',
    });

    // (3) Hesap ürünü — süreli (validity_days), alan şemalı; 1 adet stok.
    const accountProduct = await createProduct(db, {
      tag: TAG,
      kind: 'account',
      usageMode: 'single',
      validityDays: VALIDITY_DAYS,
      payloadSchema: ACCOUNT_SCHEMA,
    });
    const accountItem = await insertAccountItem(accountProduct.id);

    const rpKey = `rp-key-${randomUUID().slice(0, 8)}`;
    const rpMak = `rp-mak-${randomUUID().slice(0, 8)}`;
    const rpAcc = `rp-acc-${randomUUID().slice(0, 8)}`;
    for (const [productId, remoteProductId] of [
      [keyProduct.id, rpKey],
      [makProduct.id, rpMak],
      [accountProduct.id, rpAcc],
    ] as const) {
      await productsService.createMapping({ siteId: site.id, productId, remoteProductId });
    }

    const siteObj = { id: site.id } as Site;
    const dto: CreateOrderRequest = {
      remoteOrderId: `ord-${randomUUID().slice(0, 8)}`,
      customerEmail: `${TAG}@example.test`,
      lines: [
        { remoteLineId: 'line-key', remoteProductId: rpKey, qty: 2 },
        { remoteLineId: 'line-mak', remoteProductId: rpMak, qty: 3 },
        { remoteLineId: 'line-acc', remoteProductId: rpAcc, qty: 1 },
      ],
    };

    const beforeCreateMs = Date.now();
    const { httpStatus, body } = await orders.createOrder(siteObj, dto);

    fx = {
      site: siteObj,
      orderId: body.orderId,
      httpStatus,
      keyProductId: keyProduct.id,
      makProductId: makProduct.id,
      accountProductId: accountProduct.id,
      accountItemId: accountItem.id,
      beforeCreateMs,
    };
  });

  afterAll(async () => {
    await cleanupByTag(db, TAG);
    await end();
  });

  it('her satır KENDİ ürün tipine göre atanır; sipariş tamamen teslim edilir', async () => {
    expect(fx.httpStatus).toBe(201);

    const lines = await db
      .select({
        id: orderLines.id,
        remoteLineId: orderLines.remoteLineId,
        productId: orderLines.productId,
        qty: orderLines.qty,
        fulfilledQty: orderLines.fulfilledQty,
        status: orderLines.status,
      })
      .from(orderLines)
      .where(eq(orderLines.orderId, fx.orderId));
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l.status).toBe('fulfilled');

    const byRemote = new Map(lines.map((l) => [l.remoteLineId, l]));
    expect(byRemote.get('line-key')).toMatchObject({ qty: 2, fulfilledQty: 2 });
    expect(byRemote.get('line-mak')).toMatchObject({ qty: 3, fulfilledQty: 3 });
    expect(byRemote.get('line-acc')).toMatchObject({ qty: 1, fulfilledQty: 1 });

    const rows = await db
      .select({
        lineId: assignments.lineId,
        licenseItemId: assignments.licenseItemId,
        units: assignments.units,
        status: assignments.status,
        validUntil: assignments.validUntil,
      })
      .from(assignments)
      .where(eq(assignments.orderId, fx.orderId));

    const forLine = (remoteLineId: string) =>
      rows.filter((r) => r.lineId === byRemote.get(remoteLineId)!.id);

    // (1) Tek kullanımlık: 2 birim = 2 AYRI kalem = 2 atama (units=1).
    const keyRows = forLine('line-key');
    expect(keyRows).toHaveLength(2);
    expect(keyRows.every((r) => r.units === 1)).toBe(true);
    expect(new Set(keyRows.map((r) => r.licenseItemId)).size).toBe(2);
    const keyItems = await db
      .select({ status: licenseItems.status })
      .from(licenseItems)
      .where(eq(licenseItems.productId, fx.keyProductId));
    expect(keyItems.every((i) => i.status === 'assigned')).toBe(true);

    // (2) MAK: 3 birim TEK anahtardan → 1 atama (units=3); kapasite kaldığı için 'available'.
    const makRows = forLine('line-mak');
    expect(makRows).toHaveLength(1);
    expect(makRows[0]!.units).toBe(3);
    const [makItem] = await db
      .select({ useCount: licenseItems.useCount, status: licenseItems.status })
      .from(licenseItems)
      .where(eq(licenseItems.productId, fx.makProductId));
    expect(makItem!.useCount).toBe(3);
    expect(makItem!.status).toBe('available');

    // (3) Hesap: 1 atama, kalem 'assigned'.
    const accRows = forLine('line-acc');
    expect(accRows).toHaveLength(1);
    expect(accRows[0]!.units).toBe(1);
    expect(accRows[0]!.licenseItemId).toBe(fx.accountItemId);
    const [accItem] = await db
      .select({ status: licenseItems.status })
      .from(licenseItems)
      .where(eq(licenseItems.id, fx.accountItemId));
    expect(accItem!.status).toBe('assigned');

    // Sipariş bütünü: tüm satırlar tam → 'fulfilled'.
    const [order] = await db
      .select({ status: schema.orders.status })
      .from(schema.orders)
      .where(eq(schema.orders.id, fx.orderId));
    expect(order!.status).toBe('fulfilled');
  });

  it('validity_days → valid_until TESLİMAT ANINDAN türetilir; süresiz ürünlerde null kalır', async () => {
    const rows = await db
      .select({
        licenseItemId: assignments.licenseItemId,
        validUntil: assignments.validUntil,
        deliveredAt: assignments.deliveredAt,
      })
      .from(assignments)
      .where(eq(assignments.orderId, fx.orderId));

    const account = rows.find((r) => r.licenseItemId === fx.accountItemId);
    expect(account?.validUntil).toBeInstanceOf(Date);
    expect(account?.deliveredAt).toBeInstanceOf(Date);

    // SABİT TARİH YOK: beklenen değer, createOrder'dan hemen önceki damganın 365 gün sonrasıdır.
    // Tolerans, testin kendi süresini + saat kaymasını kapsayacak kadar dar (±5 dk) tutulur;
    // 364/366 gibi bir sapma ya da "sabit tarih" regresyonu bu pencereden taşar.
    const expected = fx.beforeCreateMs + VALIDITY_DAYS * DAY_MS;
    const drift = Math.abs(account!.validUntil!.getTime() - expected);
    expect(drift).toBeLessThan(5 * 60_000);

    // Süresiz (validity_days=null) ürünlerin atamaları valid_until TAŞIMAZ — aksi halde
    // getDeliveries savunma filtresi ve expiry sweep'i kalıcı lisansları gizlerdi.
    const others = rows.filter((r) => r.licenseItemId !== fx.accountItemId);
    expect(others).toHaveLength(3);
    for (const o of others) expect(o.validUntil).toBeNull();
  });

  it('getDeliveries: hesap ALAN-ALAN, key/MAK düz payload; ilerleme BİRİM üzerinden', async () => {
    const res = await orders.getDeliveries(fx.site, fx.orderId);

    expect(res.status).toBe('fulfilled');
    expect(res.deliveries).toHaveLength(4);
    // İlerleme ADET değil BİRİM sayar: 2 + 3 + 1 = 6.
    expect(res.total).toBe(6);
    expect(res.fulfilled).toBe(6);

    const account = res.deliveries.find((d) => d.remoteLineId === 'line-acc');
    expect(account).toBeDefined();
    expect(account!.kind).toBe('account');
    // Hesap ürününde düz `payload` DÖNMEZ — alanlar şemaya göre çözülür.
    expect(account!.payload).toBeNull();
    expect(account!.fields).not.toBeNull();
    const fields = Object.fromEntries(account!.fields!.map((f) => [f.key, f]));
    expect(fields['username']).toMatchObject({
      label: 'Kullanıcı adı',
      value: ACCOUNT_VALUES.username,
      secret: false,
    });
    // Müşteri KENDİ lisansını tam görür (maskeleme yalnız admin/mağaza yüzeyindedir),
    // ama alan `secret` işaretini taşır → admin tarafı maskeleyebilsin.
    expect(fields['password']).toMatchObject({
      label: 'Parola',
      value: ACCOUNT_VALUES.password,
      secret: true,
    });
    expect(account!.validUntil).not.toBeNull();
    expect(account!.expired).toBe(false);

    // key: düz string payload, alan YOK, birim 1.
    const keyItems = res.deliveries.filter((d) => d.remoteLineId === 'line-key');
    expect(keyItems).toHaveLength(2);
    for (const d of keyItems) {
      expect(d.kind).toBe('key');
      expect(d.fields).toBeNull();
      expect(typeof d.payload).toBe('string');
      expect(d.payload!.startsWith('SINGLEKEY-')).toBe(true);
      expect(d.units).toBe(1);
      expect(d.validUntil).toBeNull();
    }

    // MAK: TEK teslimat kaydı ama units=3 (müşteri 3 kullanım hakkı taşıyan 1 anahtar alır).
    const mak = res.deliveries.filter((d) => d.remoteLineId === 'line-mak');
    expect(mak).toHaveLength(1);
    expect(mak[0]!.units).toBe(3);
    expect(mak[0]!.fields).toBeNull();
    expect(mak[0]!.payload!.startsWith('MAKKEY-')).toBe(true);
  });
});
