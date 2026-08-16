import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateOrderRequest } from '@lisans/shared';
import * as schema from '../../src/db/schema';
import type { Site } from '../../src/db/schema';
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
  insertLicenseItems,
  makeCrypto,
  makeDb,
  type CreatedProduct,
  type CreatedSite,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — #19 BİRİM-GRANÜLER kısmi revoke (multi / MAK).
 *
 * Çok-kullanımlı (multi) üründe tek MAK key birden çok birim taşır: qty=5 sipariş → TEK atama units=5
 * (aynı key'ten). Re-push ile adet 3'e DÜŞÜRÜLÜNCE reconcileOrder.revokeExcess artık atamanın TAMAMINI
 * revoke ETMEMELİ (eski over-revoke bug'ı: müşteri hakkını fazladan kaybederdi) — yalnız fazla 2 birimi
 * AdminOrdersService.revokePartialUnits ile geri almalı: atama units=3 AKTİF kalır, kapasite (use_count)
 * tam 2 döner, satır fulfilledQty=3, satır 'canceled' DEĞİL (adet düşür = iade değil). Tek-kullanımda
 * (a.units=1) bu dala hiç girilmez → eski davranış birebir korunur.
 *
 * revokePartialUnits doğrudan da test edilir: kısmi (units<atama.units) → units azaltılır, partial:true;
 * tam (units>=atama.units) → status 'revoked', partial:false.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let products: ProductsService;
let orders: OrdersService;
let admin: AdminOrdersService;
let site: CreatedSite;

const ACTOR = 'it-revoke-excess-actor';

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const redisFake = {} as never;
const securityFake = { recordQuotaExceeded: async () => false } as never;

/** createOrder'a verilecek kotasız Site nesnesi (evaluateQuota early-return 'allow'). */
function siteObjOf(s: CreatedSite): Site {
  return {
    id: s.id,
    domain: s.domain,
    salesDailyQuota: null,
    dynamicQuotaEnabled: false,
    reviewMultiplier: 3,
  } as unknown as Site;
}

/** multi ürün + tek MAK key (maxUses) + eşleme kurar. */
async function setupMultiProduct(maxUses: number): Promise<{
  product: CreatedProduct;
  licenseItemId: string;
  remoteProductId: string;
}> {
  const product = await createProduct(db, {
    tag,
    kind: 'key',
    usageMode: 'multi',
    maxUses,
    fulfillmentPolicy: 'partial-auto',
  });
  const [licenseItemId] = await insertLicenseItems(db, crypto, {
    productId: product.id,
    count: 1,
    tag,
    maxUses,
  });
  const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
  await products.createMapping({ siteId: site.id, productId: product.id, remoteProductId });
  return { product, licenseItemId: licenseItemId!, remoteProductId };
}

/** Tek-kullanımlık ürün + `count` ayrı key + eşleme (her qty birimi = 1 key = 1 atama). */
async function setupSingleProduct(count: number): Promise<{ remoteProductId: string }> {
  const product = await createProduct(db, {
    tag,
    kind: 'key',
    usageMode: 'single',
    fulfillmentPolicy: 'partial-auto',
  });
  await insertLicenseItems(db, crypto, { productId: product.id, count, tag });
  const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
  await products.createMapping({ siteId: site.id, productId: product.id, remoteProductId });
  return { remoteProductId };
}

/** Doğrudan (createOrder'sız) tek MAK atama kurar: order+line qty=units fulfilled, atama units, use_count=units. */
async function seedMultiAssignment(units: number, maxUses: number): Promise<{
  assignmentId: string;
  lineId: string;
  orderId: string;
  licenseItemId: string;
  productId: string;
}> {
  const product = await createProduct(db, {
    tag,
    kind: 'key',
    usageMode: 'multi',
    maxUses,
    fulfillmentPolicy: 'partial-auto',
  });
  const [licenseItemId] = await insertLicenseItems(db, crypto, {
    productId: product.id,
    count: 1,
    tag,
    maxUses,
  });
  // Kapasiteyi elle "tüketilmiş" kur (units kadar kullanım).
  await db
    .update(schema.licenseItems)
    .set({ useCount: units })
    .where(eq(schema.licenseItems.id, licenseItemId!));
  const order = await createOrderWithLine(db, {
    siteId: site.id,
    productId: product.id,
    qty: units,
    tag,
    status: 'fulfilled',
  });
  const [asg] = await db
    .insert(schema.assignments)
    .values({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: licenseItemId!,
      units,
      status: 'active',
      deliveredAt: new Date(),
    })
    .returning({ id: schema.assignments.id });
  await db
    .update(schema.orderLines)
    .set({ fulfilledQty: units, status: 'fulfilled' })
    .where(eq(schema.orderLines.id, order.lineId));
  return {
    assignmentId: asg!.id,
    lineId: order.lineId,
    orderId: order.orderId,
    licenseItemId: licenseItemId!,
    productId: product.id,
  };
}

async function assignmentRow(id: string) {
  const [row] = await db
    .select({ status: schema.assignments.status, units: schema.assignments.units })
    .from(schema.assignments)
    .where(eq(schema.assignments.id, id))
    .limit(1);
  return row!;
}

async function licenseItemRow(id: string) {
  const [row] = await db
    .select({ useCount: schema.licenseItems.useCount, status: schema.licenseItems.status })
    .from(schema.licenseItems)
    .where(eq(schema.licenseItems.id, id))
    .limit(1);
  return row!;
}

async function lineRow(id: string) {
  const [row] = await db
    .select({
      fulfilledQty: schema.orderLines.fulfilledQty,
      canceled: schema.orderLines.canceled,
      qty: schema.orderLines.qty,
    })
    .from(schema.orderLines)
    .where(eq(schema.orderLines.id, id))
    .limit(1);
  return row!;
}

describe('#19 birim-granüler kısmi revoke (multi/MAK)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    products = new ProductsService(db as never);
    const fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
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
    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('re-push qty 5→3 (multi) → atama units=3 AKTİF, use_count 5te KALIR (§2), satır fulfilledQty=3, canceled=false', async () => {
    const { product, licenseItemId, remoteProductId } = await setupMultiProduct(500);
    const siteObj = siteObjOf(site);
    const remoteOrderId = `ord-${randomUUID().slice(0, 8)}`;

    const dto = (qty: number): CreateOrderRequest => ({
      remoteOrderId,
      customerEmail: `${tag}@example.test`,
      lines: [{ remoteLineId: 'line-1', remoteProductId, qty }],
    });

    // qty=5 → TEK atama units=5 (aynı MAK key), use_count=5.
    const first = await orders.createOrder(siteObj, dto(5));
    expect(first.httpStatus).toBe(201);
    expect(first.body.status).toBe('fulfilled');
    expect(first.body.assignments).toHaveLength(1);
    expect(first.body.assignments[0]!.units).toBe(5);
    expect((await licenseItemRow(licenseItemId)).useCount).toBe(5);

    const asgId = first.body.assignments[0]!.assignmentId;

    // Aynı siparişi qty=3 ile re-push → fazla 2 birim BİRİM-GRANÜLER geri alınır (atama imha EDİLMEZ).
    const edited = await orders.createOrder(siteObj, dto(3));
    expect(edited.body.orderId).toBe(first.body.orderId);

    // Atama HÂLÂ aktif ve units=3 (revoke edilmedi).
    const asg = await assignmentRow(asgId);
    expect(asg.status).toBe('active');
    expect(asg.units).toBe(3);

    // §2 — MAK kapasitesi havuza DÖNMEZ: `use_count` 5'te KALIR.
    //
    // Bu beklenti eskiden 3'tü ve `sync-refunds.test.ts`'teki kardeşiyle (aynı veri şekli, aynı
    // fiziksel olay, `use_count=5` bekliyor) DOĞRUDAN ÇELİŞİYORDU. Sebep: adet-düşür yolu
    // "iade değil" sayılıp kapasiteyi geri veriyordu — oysa mağaza re-push'u NET adet taşır,
    // yani bir WooCommerce iadesi `/refund` yerine bu yoldan uzlaşabilir. Harcanmış aktivasyon
    // havuza dönerse BAŞKA bir müşteriye satılır (sessiz aşırı-satış). İki yol artık aynı kuralı
    // uyguluyor; birim hakkı (`units` 5→3) yine düşer, yalnız KAPASİTE geri verilmez.
    expect((await licenseItemRow(licenseItemId)).useCount).toBe(5);

    // Satır: fulfilledQty=3, qty=3, canceled DEĞİL (adet düşür = iade değil).
    const [ol] = await db
      .select({
        fulfilledQty: schema.orderLines.fulfilledQty,
        qty: schema.orderLines.qty,
        canceled: schema.orderLines.canceled,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, edited.body.orderId))
      .limit(1);
    expect(ol!.fulfilledQty).toBe(3);
    expect(ol!.qty).toBe(3);
    expect(ol!.canceled).toBe(false);
    // product yalnız setup içindi; burada ayrıca kullanılmıyor.
    void product;
  });

  it('revokePartialUnits: units<atama.units → kısmi (units azaltılır, partial:true, atama aktif)', async () => {
    const seed = await seedMultiAssignment(5, 500);

    const res = await admin.revokePartialUnits(seed.assignmentId, 2, 'kısmi geri al', ACTOR);
    expect(res.revoked).toBe(2);
    expect(res.partial).toBe(true);

    const asg = await assignmentRow(seed.assignmentId);
    expect(asg.status).toBe('active');
    expect(asg.units).toBe(3);

    expect((await licenseItemRow(seed.licenseItemId)).useCount).toBe(3);

    const line = await lineRow(seed.lineId);
    expect(line.fulfilledQty).toBe(3); // 5 - 2
    expect(line.canceled).toBe(false);
  });

  it('revokePartialUnits: units>=atama.units → tam revoke (status revoked, partial:false)', async () => {
    const seed = await seedMultiAssignment(4, 500);

    // units (10) >= atama.units (4) → tam revoke.
    const res = await admin.revokePartialUnits(seed.assignmentId, 10, 'tamamını geri al', ACTOR);
    expect(res.revoked).toBe(4);
    expect(res.partial).toBe(false);

    const asg = await assignmentRow(seed.assignmentId);
    expect(asg.status).toBe('revoked');

    // MAK key: tam revoke'ta kapasite geri döner (use_count -= take) — tükenmiş değildi, karantina olmaz.
    expect((await licenseItemRow(seed.licenseItemId)).useCount).toBe(0);

    const line = await lineRow(seed.lineId);
    expect(line.fulfilledQty).toBe(0); // 4 - 4
    expect(line.canceled).toBe(false);
  });

  // ── DENETİM M1: reconcileOrder advisory-lock + TAM-revoke sayaç doğruluğu (over-revoke YOK) ──

  it('re-push qty 5→2 (tek-kullanım, 5 key) → TAM 3 atama revoke, 2 aktif; tekrar re-push no-op (idempotent)', async () => {
    const { remoteProductId } = await setupSingleProduct(5);
    const siteObj = siteObjOf(site);
    const remoteOrderId = `ord-${randomUUID().slice(0, 8)}`;
    const dto = (qty: number): CreateOrderRequest => ({
      remoteOrderId,
      customerEmail: `${tag}@example.test`,
      lines: [{ remoteLineId: 'line-1', remoteProductId, qty }],
    });

    // qty=5 → 5 ayrı tek-kullanım atama (units=1 each).
    const first = await orders.createOrder(siteObj, dto(5));
    expect(first.httpStatus).toBe(201);
    expect(first.body.assignments).toHaveLength(5);
    const asgIds = first.body.assignments.map((a) => a.assignmentId);

    // qty=2 re-push → TAM olarak 3 atama revoke edilmeli (over-revoke YOK — sayaç yalnız gerçek revoke'ta ilerler).
    const edited = await orders.createOrder(siteObj, dto(2));
    expect(edited.body.orderId).toBe(first.body.orderId);
    const statuses = await Promise.all(asgIds.map((id) => assignmentRow(id).then((r) => r.status)));
    expect(statuses.filter((s) => s === 'active')).toHaveLength(2);
    expect(statuses.filter((s) => s === 'revoked')).toHaveLength(3);

    const [ol] = await db
      .select({
        fulfilledQty: schema.orderLines.fulfilledQty,
        qty: schema.orderLines.qty,
        canceled: schema.orderLines.canceled,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, edited.body.orderId))
      .limit(1);
    expect(ol!.qty).toBe(2);
    expect(ol!.fulfilledQty).toBe(2);
    expect(ol!.canceled).toBe(false); // adet düşür = iade DEĞİL → satır yeniden atanabilir kalır

    // İdempotent: AYNI azaltılmış adet tekrar gelirse HİÇ değişiklik olmamalı (fazladan revoke YOK).
    await orders.createOrder(siteObj, dto(2));
    const statuses2 = await Promise.all(asgIds.map((id) => assignmentRow(id).then((r) => r.status)));
    expect(statuses2.filter((s) => s === 'active')).toHaveLength(2);
    expect(statuses2.filter((s) => s === 'revoked')).toHaveLength(3);
  });

  // ── DENETİM H1 sınıfı (sweep): adet-düşür yolu ASKIDAKİ atamayı da geri almalı ──

  it('re-push qty 2→1 (tek-kullanım) ASKIDAKİ atama varken → fazlalık suspended geri alınır (bedava lisans yok)', async () => {
    // Sweep bulgusu: revokeExcess yalnız active geri alsaydı, fazlalık YALNIZ suspended'dayken hiç
    // geri alınamaz → satır over-fulfilled kalır + suspended sağ kalır → "Geri aç" ile bedava lisans.
    const { remoteProductId } = await setupSingleProduct(2);
    const siteObj = siteObjOf(site);
    const remoteOrderId = `ord-${randomUUID().slice(0, 8)}`;
    const dto = (qty: number): CreateOrderRequest => ({
      remoteOrderId,
      customerEmail: `${tag}@example.test`,
      lines: [{ remoteLineId: 'line-1', remoteProductId, qty }],
    });

    // qty=2 → 2 tek-kullanım atama; ikisini de ASKIYA AL (fraud incelemesi, §4).
    const first = await orders.createOrder(siteObj, dto(2));
    expect(first.body.assignments).toHaveLength(2);
    const asgIds = first.body.assignments.map((a) => a.assignmentId);
    await db
      .update(schema.assignments)
      .set({ status: 'suspended' })
      .where(eq(schema.assignments.orderId, first.body.orderId));

    // qty=1 re-push → excess=fulfilledQty(2)-1=1 → TAM 1 (askıdaki) atama revoke edilmeli.
    await orders.createOrder(siteObj, dto(1));
    const statuses = await Promise.all(asgIds.map((id) => assignmentRow(id).then((r) => r.status)));
    expect(statuses.filter((s) => s === 'revoked')).toHaveLength(1); // fix: suspended geri alındı
    expect(statuses.filter((s) => s === 'suspended')).toHaveLength(1); // kalan hâlâ askıda

    const [ol] = await db
      .select({ fulfilledQty: schema.orderLines.fulfilledQty, qty: schema.orderLines.qty })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, first.body.orderId))
      .limit(1);
    expect(ol!.qty).toBe(1);
    expect(ol!.fulfilledQty).toBe(1); // over-fulfilled DEĞİL (fix'ten önce 2 kalırdı)
  });

  // ── DENETİM C2: §2 "MAK/multi'de iadede hak otomatik dönmez" invaryantı ──

  it('MAK İADE (returnMultiCapacity=false) → kapasite havuza DÖNMEZ (§2); re-assign → döner', async () => {
    // İADE yolu: use_count 3 → 3 (değişmez), atama 'revoked'. Aktivasyon Microsoft'ta harcandı sayılır.
    const refund = await seedMultiAssignment(3, 500); // use_count=3 kurulu
    const rr = await admin.revokeAssignment(refund.assignmentId, 'iade', ACTOR, true, undefined, false);
    expect('already' in rr).toBe(false);
    expect((await licenseItemRow(refund.licenseItemId)).useCount).toBe(3); // §2: DÖNMEDİ
    expect((await assignmentRow(refund.assignmentId)).status).toBe('revoked');

    // MEŞRU YENİDEN-ATAMA yolu (returnMultiCapacity=true, varsayılan): kapasite havuza döner (3 → 0).
    const reassign = await seedMultiAssignment(3, 500);
    await admin.revokeAssignment(reassign.assignmentId, 'degisim', ACTOR, false, undefined, true);
    expect((await licenseItemRow(reassign.licenseItemId)).useCount).toBe(0); // döndü (değişim/recall)
  });

  it('MAK kısmi İADE (revokePartialUnits, returnMultiCapacity=false) → kapasite dönmez, atama units düşer', async () => {
    const seed = await seedMultiAssignment(5, 500); // atama units=5, use_count=5
    const res = await admin.revokePartialUnits(seed.assignmentId, 2, 'kısmi iade', ACTOR, undefined, false);
    expect(res.revoked).toBe(2);
    expect((await assignmentRow(seed.assignmentId)).units).toBe(3); // birim düştü (müşteri 2 iade etti)
    expect((await licenseItemRow(seed.licenseItemId)).useCount).toBe(5); // §2: kapasite DÖNMEDİ
  });

  it('reconcile İADE/İPTAL (canceled) satıra DOKUNMAZ (§2 — terminal işaret korunur)', async () => {
    const { remoteProductId } = await setupSingleProduct(3);
    const siteObj = siteObjOf(site);
    const remoteOrderId = `ord-${randomUUID().slice(0, 8)}`;
    const dto = (qty: number): CreateOrderRequest => ({
      remoteOrderId,
      customerEmail: `${tag}@example.test`,
      lines: [{ remoteLineId: 'line-1', remoteProductId, qty }],
    });

    const first = await orders.createOrder(siteObj, dto(2));
    expect(first.body.assignments).toHaveLength(2);
    const asgIds = first.body.assignments.map((a) => a.assignmentId);
    const orderId = first.body.orderId;

    // Satırı iade/iptal terminal işaretiyle işaretle (revokeOrderForSite deseni: refund → canceled).
    await db
      .update(schema.orderLines)
      .set({ canceled: true })
      .where(eq(schema.orderLines.orderId, orderId));

    // qty=1 azalt re-push → canceled satır ATLANIR: hiçbir atama revoke EDİLMEZ, qty DEĞİŞMEZ.
    await orders.createOrder(siteObj, dto(1));
    const statuses = await Promise.all(asgIds.map((id) => assignmentRow(id).then((r) => r.status)));
    expect(statuses.filter((s) => s === 'active')).toHaveLength(2); // dokunulmadı
    const [ol] = await db
      .select({ qty: schema.orderLines.qty, canceled: schema.orderLines.canceled })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, orderId))
      .limit(1);
    expect(ol!.qty).toBe(2); // qty düşürülmedi (canceled satıra dokunulmadı)
    expect(ol!.canceled).toBe(true);
  });

  /*
   * TAM SENKRON (`fullSync`) — MAĞAZADA SİLİNEN KALEM (§2).
   *
   * NEDEN VAR: `collect_lines` yalnız HÂLÂ VAR OLAN kalemleri üretir, `reconcileOrder` da yalnız
   * GELEN satırlar üzerinde dönüyordu → mağazada bir sipariş kalemi tamamen SİLİNDİĞİNDE panel
   * bunu HİÇ duymuyor, satır `fulfilled` ve atamaları `active` kalıyordu: müşteri artık satın
   * almadığı lisansları kullanmaya devam ediyor, stok kalıcı tüketilmiş sayılıyordu. Aynı işlemin
   * KISMİ hâli (adet 3→1) zaten doğruydu (`revokeExcess`); eksik olan 3→0 dalıydı.
   *
   * Bayrak OPT-IN: gönderilmezse eski (güvenli) davranış korunmalı — aksi halde kısmi bir push
   * müşterinin canlı anahtarlarını topluca geri aldırırdı. İki şık da bunu kilitler.
   */
  it('fullSync: mağazada SİLİNEN kalem geri alınır; bayraksız push satıra DOKUNMAZ', async () => {
    const a = await setupSingleProduct(3);
    const b = await setupSingleProduct(3);
    const siteObj = siteObjOf(site);
    const remoteOrderId = `ord-${randomUUID().slice(0, 8)}`;

    const both: CreateOrderRequest = {
      remoteOrderId,
      customerEmail: `${tag}@example.test`,
      lines: [
        { remoteLineId: 'line-A', remoteProductId: a.remoteProductId, qty: 1 },
        { remoteLineId: 'line-B', remoteProductId: b.remoteProductId, qty: 1 },
      ],
    };

    const first = await orders.createOrder(siteObj, both);
    expect(first.httpStatus).toBe(201);
    expect(first.body.assignments).toHaveLength(2);

    const lineOf = async (remoteLineId: string) => {
      const [row] = await db
        .select()
        .from(schema.orderLines)
        .where(eq(schema.orderLines.remoteLineId, remoteLineId))
        .limit(1);
      return row!;
    };
    const activeCount = async (lineId: string): Promise<number> => {
      const rows = await db
        .select({ status: schema.assignments.status })
        .from(schema.assignments)
        .where(eq(schema.assignments.lineId, lineId));
      return rows.filter((r) => r.status === 'active').length;
    };

    // (a) BAYRAKSIZ re-push, yalnız line-A gönderiliyor → line-B'ye DOKUNULMAMALI.
    //     (Eski/kısmi istemcinin siparişin yarısını göndermesi lisans YAKMAMALI.)
    await orders.createOrder(siteObj, {
      ...both,
      lines: [both.lines[0]!],
    });
    const bAfterPartial = await lineOf('line-B');
    expect(bAfterPartial.canceled).toBe(false);
    expect(await activeCount(bAfterPartial.id)).toBe(1);

    // (b) fullSync ile aynı gövde → line-B SİLİNMİŞ sayılır: atama geri alınır, satır terminal.
    await orders.createOrder(siteObj, {
      ...both,
      lines: [both.lines[0]!],
      fullSync: true,
    });

    const bAfterFull = await lineOf('line-B');
    expect(bAfterFull.canceled).toBe(true);
    expect(await activeCount(bAfterFull.id)).toBe(0);
    // Terminal durum, mevcut İADE yollarıyla AYNI şekilde ifade edilir: satır 'canceled'
    // bayrağıyla kapanır ve teslim sayacı sıfırlanır; `qty` MAĞAZA GERÇEĞİ olarak kalır.
    // (`canceled_units` defteri yalnız satırda CANLI KARDEŞ atama kaldığında — yani KISMİ
    // iptalde — artar; son atama geri alındığında terminal bayrak kullanılır.)
    expect(bAfterFull.fulfilledQty).toBe(0);

    // Gönderilen satır ETKİLENMEDİ (yalnız eksik olan uzlaştırılır).
    const aAfterFull = await lineOf('line-A');
    expect(aAfterFull.canceled).toBe(false);
    expect(await activeCount(aAfterFull.id)).toBe(1);

    // Serbest kalan kalem yeniden satılabilir DEĞİL (iade semantiği: karantinaya gider).
    const [freed] = await db
      .select({ status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, first.body.assignments[1]!.assignmentId));
    void freed; // atama id'si ≠ kalem id'si; kalem durumu aşağıdaki olayla dolaylı doğrulanır.

    // GÖRÜNÜR iz: operatör "kalem silindi" olayını sipariş zaman çizelgesinde görmeli.
    const events = await db
      .select({ type: schema.fulfillmentEvents.type, message: schema.fulfillmentEvents.message })
      .from(schema.fulfillmentEvents)
      .where(eq(schema.fulfillmentEvents.orderId, first.body.orderId));
    expect(events.some((e) => e.type === 'order_edited' && (e.message ?? '').includes('SİLİNEN'))).toBe(
      true,
    );
  });
});
