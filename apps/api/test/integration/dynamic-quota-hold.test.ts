import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { BadRequestException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateOrderRequest } from '@jetlisans/shared';
import * as schema from '../../src/db/schema';
import type { Site } from '../../src/db/schema';
import { OrdersService } from '../../src/orders/orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { ProductsService } from '../../src/products/products.service';
import { SitesService } from '../../src/sites/sites.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  tagPrefix,
  type CreatedProduct,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — §8 dinamik kota → held_for_review (İnceleme Kuyruğu).
 *
 * dynamicQuotaEnabled açık bir sitede günlük sipariş sayısı dinamik eşiği (yeni site için
 * DYNAMIC_MIN_FLOOR=20) aşınca sipariş REDDEDİLMEZ; heldForReview=true ile KABUL edilir ama
 * teslimat YAPILMAZ (atama yok) → admin "İnceleme Kuyruğu"nda Onayla (releaseHeld → completeLine)
 * / Reddet (rejectHeld → satırlar canceled). Bayrak KAPALIYKEN (varsayılan) hiçbir sipariş held
 * olmaz (geriye dönük uyumlu). Bu dosya o hold kararını + admin kuyruk yaşam-döngüsünü kilitler.
 *
 * createOrder(site, dto) kotayı PASING site nesnesinden okur (evaluateQuota: site.dynamicQuotaEnabled
 * / reviewMultiplier / salesDailyQuota); bugünkü sayım orders tablosundan (site.id) gelir. Bu yüzden
 * eşiğe ya 21 gerçek createOrder ile ya da 20 "dolgu" order satırı doğrudan drizzle ile eklenerek varılır.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let products: ProductsService;
let orders: OrdersService;
let admin: AdminOrdersService;
// Modül kapsamında tutulur → testler completeLine/autoCompleteProduct'ı doğrudan çağırabilir
// (releaseHeld all-or-nothing + Finding F held payload-leak savunması).
let fulfillment: FulfillmentService;

const ACTOR = 'it-quota-actor';

// Nest DI olmadan hafif sahteler (bu testin kapsamı DB davranışı; mail/webhook/redis/security yan etkileri değil).
const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;
// Sert-kota catch'i security.recordQuotaExceeded, held yolu recordQuotaHeld çağırır (bu dosyada
// best-effort; ikisi de sahtelensin ki createOrder held/reddet dalları arayüz eksikliğinden patlamasın).
const securityFake = {
  recordQuotaExceeded: async () => false,
  recordQuotaHeld: async () => false,
} as never;

/** dynamicQuotaEnabled açık site + tek ürün + eşleme kurar; createOrder'a verilecek Site nesnesini döndürür. */
async function setupDynamicSite(reviewMultiplier = 3): Promise<{
  siteObj: Site;
  siteId: string;
  product: CreatedProduct;
  remoteProductId: string;
}> {
  const s = await createSite(db, crypto, { tag });
  const product = await createProduct(db, {
    tag,
    kind: 'key',
    usageMode: 'single',
    fulfillmentPolicy: 'partial-auto',
  });
  const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
  await products.createMapping({ siteId: s.id, productId: product.id, remoteProductId });
  const siteObj = {
    id: s.id,
    domain: s.domain,
    salesDailyQuota: null,
    dynamicQuotaEnabled: true,
    reviewMultiplier,
  } as unknown as Site;
  return { siteObj, siteId: s.id, product, remoteProductId };
}

/** Kotasız (bayrak kapalı) site + ürün + eşleme — createOrder her zaman normal (held değil) yolu izler. */
async function setupPlainSite(): Promise<{
  siteObj: Site;
  siteId: string;
  product: CreatedProduct;
  remoteProductId: string;
}> {
  const s = await createSite(db, crypto, { tag });
  const product = await createProduct(db, {
    tag,
    kind: 'key',
    usageMode: 'single',
    fulfillmentPolicy: 'partial-auto',
  });
  const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
  await products.createMapping({ siteId: s.id, productId: product.id, remoteProductId });
  const siteObj = {
    id: s.id,
    domain: s.domain,
    salesDailyQuota: null,
    dynamicQuotaEnabled: false,
    reviewMultiplier: 3,
  } as unknown as Site;
  return { siteObj, siteId: s.id, product, remoteProductId };
}

function makeDto(remoteProductId: string, opts?: { remoteOrderId?: string; qty?: number }): CreateOrderRequest {
  return {
    remoteOrderId: opts?.remoteOrderId ?? `ord-${randomUUID().slice(0, 8)}`,
    customerEmail: `${tag}@example.test`,
    lines: [{ remoteLineId: 'line-1', remoteProductId, qty: opts?.qty ?? 1 }],
  };
}

/**
 * Bugün için `count` adet "dolgu" sipariş satırı DOĞRUDAN ekler (createOrder yolunu tetiklemeden).
 * evaluateQuota yalnız orders tablosunu (site.id + createdAt bugün) saydığından eşiğe hızlı+deterministik
 * varılır. Satır/atama gerekmez (yalnız count'a girer). Tag'li site → cleanupByTag temizler.
 */
async function seedFillerOrdersToday(siteId: string, count: number): Promise<void> {
  const rows = Array.from({ length: count }, () => {
    const rid = `${tagPrefix(tag)}-fill-${randomUUID().slice(0, 8)}`;
    return {
      siteId,
      remoteOrderId: rid,
      customerEmail: `${tag}@example.test`,
      status: 'fulfilled' as const,
      idempotencyKey: `${siteId}:${rid}`,
    };
  });
  await db.insert(schema.orders).values(rows);
}

/**
 * GEÇMİŞ (bugün öncesi) sipariş satırları ekler — dinamik eşik TABANININ (evaluateQuota'nın
 * 30 günlük penceresi) davranışını test etmek için. Yalnız `heldForReview=false AND status IN
 * ('fulfilled','partial')` VE `created_at < bugün` olanlar tabana girer; held/pending/bugünkü
 * siparişler HARİÇ (saldırgan kendi eşiğini şişiremez, #7 denetim E). createdAt açıkça `daysAgo`
 * gün öncesine set edilir (default now() ezildi). Tag'li site → cleanupByTag temizler.
 */
async function seedPastOrders(
  siteId: string,
  count: number,
  opts: { status: 'fulfilled' | 'partial' | 'pending'; heldForReview: boolean; daysAgo: number },
): Promise<void> {
  const when = new Date(Date.now() - opts.daysAgo * 86_400_000);
  const rows = Array.from({ length: count }, () => {
    const rid = `${tagPrefix(tag)}-past-${randomUUID().slice(0, 8)}`;
    return {
      siteId,
      remoteOrderId: rid,
      customerEmail: `${tag}@example.test`,
      status: opts.status,
      heldForReview: opts.heldForReview,
      idempotencyKey: `${siteId}:${rid}`,
      createdAt: when,
      updatedAt: when,
    };
  });
  await db.insert(schema.orders).values(rows);
}

describe('§8 dinamik kota → held_for_review + İnceleme Kuyruğu', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    products = new ProductsService(db as never);
    fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    admin = new AdminOrdersService(db as never, redisFake, crypto, mailFake, fulfillment);
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
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('ilk 20 sipariş teslim edilir (held değil), 21. sipariş HELD (202, held=true, atama yok)', async () => {
    const { siteObj, product, remoteProductId } = await setupDynamicSite();
    // 20 gerçek siparişin fulfilment'i için bol stok (21. held → stok tüketmez).
    await insertLicenseItems(db, crypto, { productId: product.id, count: 22, tag });

    // İlk 20: eşik altında → normal akış, fulfilled, held DEĞİL.
    for (let i = 0; i < 20; i++) {
      const res = await orders.createOrder(siteObj, makeDto(remoteProductId));
      expect(res.body.held).not.toBe(true);
      expect(res.body.status).toBe('fulfilled');
      expect(res.httpStatus).toBe(201);
    }

    // 21.: bugün 20 sipariş ≥ eşik (20) → HELD.
    const held = await orders.createOrder(siteObj, makeDto(remoteProductId));
    expect(held.httpStatus).toBe(202);
    expect(held.body.held).toBe(true);
    expect(held.body.status).toBe('pending');
    expect(held.body.assignments).toHaveLength(0);

    // Sipariş satırı held bayrağı + gerekçe; DB'de HİÇ atama yok.
    const [row] = await db
      .select({
        heldForReview: schema.orders.heldForReview,
        heldReason: schema.orders.heldReason,
        heldAt: schema.orders.heldAt,
      })
      .from(schema.orders)
      .where(eq(schema.orders.id, held.body.orderId))
      .limit(1);
    expect(row!.heldForReview).toBe(true);
    expect(row!.heldReason).toBeTruthy();
    expect(row!.heldAt).toBeTruthy();

    const asgs = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(eq(schema.assignments.orderId, held.body.orderId));
    expect(asgs).toHaveLength(0);
  });

  it('dynamicQuotaEnabled=false → sayı ne olursa olsun HİÇBİR sipariş held olmaz', async () => {
    const { siteObj, siteId, remoteProductId, product } = await setupPlainSite();
    await insertLicenseItems(db, crypto, { productId: product.id, count: 2, tag });
    // Eşik tabanının (20) çok üstünde dolgu — bayrak kapalıyken sayım YAPILMAZ (early-return 'allow').
    await seedFillerOrdersToday(siteId, 25);

    const res = await orders.createOrder(siteObj, makeDto(remoteProductId));
    expect(res.body.held).not.toBe(true);
    expect(res.body.status).toBe('fulfilled');

    const [row] = await db
      .select({ heldForReview: schema.orders.heldForReview })
      .from(schema.orders)
      .where(eq(schema.orders.id, res.body.orderId))
      .limit(1);
    expect(row!.heldForReview).toBe(false);
  });

  it('listHeldOrders() held siparişi döndürür', async () => {
    const { siteObj, siteId, remoteProductId } = await setupDynamicSite();
    await seedFillerOrdersToday(siteId, 20);
    const held = await orders.createOrder(siteObj, makeDto(remoteProductId));
    expect(held.body.held).toBe(true);

    const queue = await admin.listHeldOrders();
    const found = queue.find((o) => o.id === held.body.orderId);
    expect(found).toBeDefined();
    expect(found!.siteDomain).toBe(siteObj.domain);
  });

  it('releaseHeld() bayrağı temizler + stok varsa teslim eder (fulfilled + atama oluşur)', async () => {
    const { siteObj, siteId, remoteProductId, product } = await setupDynamicSite();
    await insertLicenseItems(db, crypto, { productId: product.id, count: 2, tag });
    await seedFillerOrdersToday(siteId, 20);
    const held = await orders.createOrder(siteObj, makeDto(remoteProductId));
    expect(held.body.held).toBe(true);

    const res = await admin.releaseHeld(held.body.orderId, ACTOR);
    expect(res.released).toBe(true);

    // Sipariş artık held değil ve teslim edildi.
    const [row] = await db
      .select({ heldForReview: schema.orders.heldForReview, status: schema.orders.status })
      .from(schema.orders)
      .where(eq(schema.orders.id, held.body.orderId))
      .limit(1);
    expect(row!.heldForReview).toBe(false);
    expect(row!.status).toBe('fulfilled');

    // Satıra aktif atama YAZILDI (teslimat başlatıldı).
    const active = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(
        and(
          eq(schema.assignments.orderId, held.body.orderId),
          eq(schema.assignments.status, 'active'),
        ),
      );
    expect(active.length).toBeGreaterThanOrEqual(1);
  });

  it('rejectHeld() → held değil, tüm satırlar canceled, sipariş revoked, atama yok', async () => {
    const { siteObj, siteId, remoteProductId, product } = await setupDynamicSite();
    // Stok VAR ama reddedilen held sipariş teslim ETMEMELİ (atama yazılmaz).
    await insertLicenseItems(db, crypto, { productId: product.id, count: 2, tag });
    await seedFillerOrdersToday(siteId, 20);
    const held = await orders.createOrder(siteObj, makeDto(remoteProductId));
    expect(held.body.held).toBe(true);

    const res = await admin.rejectHeld(held.body.orderId, 'inceleme reddi', ACTOR);
    expect(res.rejected).toBe(true);
    expect(res.status).toBe('revoked');

    const [row] = await db
      .select({ heldForReview: schema.orders.heldForReview, status: schema.orders.status })
      .from(schema.orders)
      .where(eq(schema.orders.id, held.body.orderId))
      .limit(1);
    expect(row!.heldForReview).toBe(false);
    expect(row!.status).toBe('revoked');

    // Tüm satırlar canceled.
    const lines = await db
      .select({ canceled: schema.orderLines.canceled })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, held.body.orderId));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.canceled === true)).toBe(true);

    // Hiç atama yapılmadı.
    const asgs = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(eq(schema.assignments.orderId, held.body.orderId));
    expect(asgs).toHaveLength(0);
  });

  it('held OLMAYAN siparişte: releaseHeld BadRequestException fırlatır; rejectHeld İDEMPOTENT no-op döner', async () => {
    const { siteObj, remoteProductId, product } = await setupPlainSite();
    await insertLicenseItems(db, crypto, { productId: product.id, count: 1, tag });
    const normal = await orders.createOrder(siteObj, makeDto(remoteProductId));
    expect(normal.body.held).not.toBe(true);

    // releaseHeld DEĞİŞMEDİ: held olmayan siparişte "Onayla" hâlâ hata → yanlışlıkla
    // normal siparişi yeniden teslim yolu açılamaz.
    await expect(admin.releaseHeld(normal.body.orderId, ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // rejectHeld artık İDEMPOTENT: held olmayan (zaten kapalı) siparişte FIRLATMAZ — revokeOrderForSite
    // (iade/iptal) held siparişi güvenle kapatmak için bunu koşulsuz çağırabilsin diye no-op döner.
    const rejected = await admin.rejectHeld(normal.body.orderId, 'x', ACTOR);
    expect(rejected.rejected).toBe(false);
    expect(rejected.alreadyClosed).toBe(true);
    expect(rejected.status).toBe(normal.body.status);

    // İdempotent no-op siparişin durumunu/satırlarını BOZMAMALI (canceled yapmamalı).
    const lines = await db
      .select({ canceled: schema.orderLines.canceled })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, normal.body.orderId));
    expect(lines.every((l) => l.canceled === false)).toBe(true);
  });

  it('#7 denetim (HIGH): held sipariş iade/iptal edilince (revokeOrderForSite) KAPANIR → sonradan Onaylanamaz', async () => {
    // Held bir sipariş WooCommerce'te iade/iptal edilirse İnceleme Kuyruğu'ndan çıkarılmalı; aksi
    // halde admin sonradan 'Onayla' derse iade edilmiş siparişe BEDAVA lisans teslim edilir (§2 tersi).
    const { siteObj, siteId, remoteProductId, product } = await setupDynamicSite();
    await insertLicenseItems(db, crypto, { productId: product.id, count: 2, tag });
    await seedFillerOrdersToday(siteId, 20);
    const dto = makeDto(remoteProductId);
    const held = await orders.createOrder(siteObj, dto);
    expect(held.body.held).toBe(true);

    // Site-facing revoke (WP eklentisi iade/iptalde tetikler). siteObj id+domain taşır.
    const res = await admin.revokeOrderForSite(siteObj, dto.remoteOrderId, 'WooCommerce: refunded');
    expect(res.orderId).toBe(held.body.orderId);

    // Sipariş artık held DEĞİL, tüm satırlar canceled, durum revoked.
    const [row] = await db
      .select({ heldForReview: schema.orders.heldForReview, status: schema.orders.status })
      .from(schema.orders)
      .where(eq(schema.orders.id, held.body.orderId))
      .limit(1);
    expect(row!.heldForReview).toBe(false);
    expect(row!.status).toBe('revoked');

    const lines = await db
      .select({ canceled: schema.orderLines.canceled })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, held.body.orderId));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.canceled === true)).toBe(true);

    // Aktif atama yok (held sipariş hiç teslim etmemişti; reject de bir şey revoke etmedi).
    const active = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(
        and(
          eq(schema.assignments.orderId, held.body.orderId),
          eq(schema.assignments.status, 'active'),
        ),
      );
    expect(active).toHaveLength(0);

    // KİLİT: kapatılmış (artık held olmayan) sipariş sonradan Onaylanamaz → bedava lisans imkânsız.
    await expect(admin.releaseHeld(held.body.orderId, ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('releaseHeld all-or-nothing: stok yetersizse KISMİ TESLİM ETMEZ; stok gelince manuel completeLine tam teslim eder', async () => {
    // Dinamik site + all-or-nothing single-use ürün (setupDynamicSite partial-auto kurar → inline).
    const s = await createSite(db, crypto, { tag });
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'all-or-nothing',
    });
    const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
    await products.createMapping({ siteId: s.id, productId: product.id, remoteProductId });
    const siteObj = {
      id: s.id,
      domain: s.domain,
      salesDailyQuota: null,
      dynamicQuotaEnabled: true,
      reviewMultiplier: 3,
    } as unknown as Site;

    // qty=2 istenecek ama yalnız 1 available → all-or-nothing tam karşılanamaz.
    await insertLicenseItems(db, crypto, { productId: product.id, count: 1, tag });
    await seedFillerOrdersToday(s.id, 20);

    const held = await orders.createOrder(siteObj, makeDto(remoteProductId, { qty: 2 }));
    expect(held.body.held).toBe(true);

    // Onayla: stok yetersiz → all-or-nothing satır KISMİ teslim EDİLMEMELİ (completeLine artık onurlandırır).
    await admin.releaseHeld(held.body.orderId, ACTOR);

    const [line1] = await db
      .select({
        id: schema.orderLines.id,
        status: schema.orderLines.status,
        fulfilledQty: schema.orderLines.fulfilledQty,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, held.body.orderId))
      .limit(1);
    expect(line1!.status).toBe('pending');
    expect(line1!.fulfilledQty).toBe(0);

    // Hiç atama yazılmadı (kısmi teslim yasak → kapasite geri verildi).
    const asgs1 = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(eq(schema.assignments.orderId, held.body.orderId));
    expect(asgs1).toHaveLength(0);

    // Stok gelince manuel completeLine tam teslim eder (all-or-nothing autoComplete SWEEP taramaz).
    await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      payloadPrefix: 'FRESH',
    });
    const res = await fulfillment.completeLine(line1!.id);
    expect(res.added).toBe(2);
    expect(res.status).toBe('fulfilled');

    const [line2] = await db
      .select({
        status: schema.orderLines.status,
        fulfilledQty: schema.orderLines.fulfilledQty,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, line1!.id))
      .limit(1);
    expect(line2!.status).toBe('fulfilled');
    expect(line2!.fulfilledQty).toBe(2);
  });

  it('Finding F: held sipariş payload SIZDIRMAZ — autoCompleteProduct held satırı ATLAR + completeLine noop', async () => {
    const { siteObj, siteId, remoteProductId, product } = await setupDynamicSite();
    await seedFillerOrdersToday(siteId, 20);
    const held = await orders.createOrder(siteObj, makeDto(remoteProductId));
    expect(held.body.held).toBe(true);

    // Stok girişi + autoComplete taraması — held sipariş bunu ALMAMALI (orders.held_for_review=false join).
    await insertLicenseItems(db, crypto, { productId: product.id, count: 3, tag });
    await fulfillment.autoCompleteProduct(product.id);

    const [line] = await db
      .select({
        id: schema.orderLines.id,
        status: schema.orderLines.status,
        fulfilledQty: schema.orderLines.fulfilledQty,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, held.body.orderId))
      .limit(1);
    expect(line!.status).toBe('pending');
    expect(line!.fulfilledQty).toBe(0);

    const asgs = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(eq(schema.assignments.orderId, held.body.orderId));
    expect(asgs).toHaveLength(0);

    // İkinci savunma katmanı: doğrudan completeLine held sipariş satırında NOOP (added=0).
    const res = await fulfillment.completeLine(line!.id);
    expect(res.added).toBe(0);

    const asgs2 = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(eq(schema.assignments.orderId, held.body.orderId));
    expect(asgs2).toHaveLength(0);
  });

  it('#5 dinamik eşik tabanı: ≥20 meşru-teslim geçmişte ÇARPAN kullanılır (taban değil) + held/pending SAYILMAZ', async () => {
    const s = await createSite(db, crypto, { tag });
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'partial-auto',
    });
    const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
    await products.createMapping({ siteId: s.id, productId: product.id, remoteProductId });
    const siteObj = {
      id: s.id,
      domain: s.domain,
      salesDailyQuota: null,
      dynamicQuotaEnabled: true,
      reviewMultiplier: 2,
    } as unknown as Site;

    // Geçmiş (bugün öncesi) 30 meşru-teslim (fulfilled) → recent30=30 ≥ DYNAMIC_MIN_FLOOR(20) → ÇARPAN dalı.
    //   avgDaily = 30/30 = 1.0, eşik = ceil(1.0 × 2) = 2 (taban 20 DEĞİL).
    await seedPastOrders(s.id, 30, { status: 'fulfilled', heldForReview: false, daysAgo: 5 });
    // Geçmiş 40 held sipariş — tabana KATILMAMALI. Katılsaydı recent30=70, eşik=ceil((70/30)×2)=5 olur,
    // 3. sipariş held OLMAZDI. Bu satır held/status filtresini kilitler (#7 denetim E).
    await seedPastOrders(s.id, 40, { status: 'pending', heldForReview: true, daysAgo: 5 });

    await insertLicenseItems(db, crypto, { productId: product.id, count: 3, tag });

    // Bugün: 1. ve 2. sipariş eşik (2) ALTINDA → teslim (held değil). Bugünkü siparişler tabana girmez.
    const o1 = await orders.createOrder(siteObj, makeDto(remoteProductId));
    expect(o1.body.held).not.toBe(true);
    const o2 = await orders.createOrder(siteObj, makeDto(remoteProductId));
    expect(o2.body.held).not.toBe(true);
    // 3.: bugün 2 sipariş ≥ eşik 2 → HELD. (Taban 20 olsaydı: held değil; held'ler sayılsaydı eşik 5: held değil.)
    const o3 = await orders.createOrder(siteObj, makeDto(remoteProductId));
    expect(o3.body.held).toBe(true);
    expect(o3.httpStatus).toBe(202);
  });

  it('#Finding O: dynamicQuotaEnabled DB persistence — update() yazar, DB-yüklenen site held tetikler', async () => {
    // Site NORMAL yolla oluşturulur; create() dynamicQuotaEnabled KABUL ETMEZ → default false.
    const s = await createSite(db, crypto, { tag });
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'partial-auto',
    });
    const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
    await products.createMapping({ siteId: s.id, productId: product.id, remoteProductId });

    // Bayrağı GERÇEK persistence yoluyla aç: SitesService.update DB'ye yazar (elle Site kurulmaz).
    const sites = new SitesService(db as never, crypto);
    await sites.update(s.id, { dynamicQuotaEnabled: true, reviewMultiplier: 3 });

    // DB'den TAM site satırını yeniden yükle → bayrak round-trip'i kanıtlanır.
    const [dbSite] = await db
      .select()
      .from(schema.sites)
      .where(eq(schema.sites.id, s.id))
      .limit(1);
    expect(dbSite!.dynamicQuotaEnabled).toBe(true);
    expect(dbSite!.reviewMultiplier).toBe(3);

    await insertLicenseItems(db, crypto, { productId: product.id, count: 2, tag });
    await seedFillerOrdersToday(s.id, 20);

    // DB-yüklenen site nesnesiyle createOrder → yeni-site tabanı (20) aşıldı → HELD.
    const held = await orders.createOrder(dbSite as unknown as Site, makeDto(remoteProductId));
    expect(held.body.held).toBe(true);
    expect(held.httpStatus).toBe(202);
  });
});
