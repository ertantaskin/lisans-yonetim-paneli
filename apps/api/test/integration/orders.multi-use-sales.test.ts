import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateOrderRequest } from '@lisans/shared';
import { OrdersService } from '../../src/orders/orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { ProductsService } from '../../src/products/products.service';
import { assignments, licenseItems, orderLines, type Site } from '../../src/db/schema';
import {
  cleanupByTag,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — MAK / ÇOK KULLANIMLIK (`usage_mode='multi'`) SATIŞ YOLU.
 *
 * NEDEN: MAK yalnız İADE/geri-alma/red yollarında testliydi (admin-revoke-refund-semantics,
 * revoke-excess-partial, sync-refunds). SATIŞ tarafı — yani `allocate()` → `consumeMultiUseCapacity`
 * zinciri — hiç doğrulanmıyordu: `orders.createOrder.test.ts` içinde `multi` kelimesi HİÇ geçmiyor.
 * Oysa MAK'ta bir ANAHTAR birden çok BİRİM taşır (1 key = N kullanım) ve panelin en tehlikeli
 * sessiz hatası tam burada doğar: kapasite aşımı = aynı aktivasyon iki müşteriye satılmış demektir
 * (§2 "çifte satış imkânsız" invaryantı).
 *
 * DAVRANIŞ ODAKLI: testler `consumeMultiUseCapacity`'nin İÇ İMZASINA bakmaz (o fonksiyon toplu-alma
 * yapacak şekilde değişti: artık `{licenseItemId, taken}` döner ve `allocate` ANAHTAR başına döner).
 * Doğrulanan şey SONUÇTUR: kaç atama oluştu, hangi anahtardan kaç birim düştü, toplam kapasite aşıldı mı.
 *
 * Kapsam:
 *   (a1) Kısmi kapasite tüketimi → TEK atama, units=3, kalem hâlâ 'available'.
 *   (a2) Taşma → kalan ilk anahtardan, artan İKİNCİ anahtardan (FEFO/seq sırası korunur).
 *   (a3) Kapasiteden fazla talep → kapasite kadar teslim, AŞILMAZ (bu dosyanın çekirdek invaryantı).
 *   (a4) Kapasite tükendikten sonra yeni sipariş → 0 atama (over-fulfillment yok).
 */

const TAG = randomUUID().slice(0, 8);

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

/**
 * MAK senaryosu: site + `usage_mode='multi'` ürün + `keys` adet anahtar (her biri `maxUses`
 * kapasiteli) + eşleme. Toplam kapasite = keys × maxUses.
 */
async function makScenario(opts: {
  keys: number;
  maxUses: number;
  fulfillmentPolicy?: 'partial-auto' | 'partial-approval' | 'all-or-nothing';
  /** MAK dağıtımı — verilmezse VARSAYILAN ('fewest-keys', eski davranış) kullanılır. */
  multiUseDistribution?: 'fewest-keys' | 'one-per-key';
}) {
  const site = await createSite(db, crypto, { tag: TAG });
  const product = await createProduct(db, {
    tag: TAG,
    kind: 'key',
    usageMode: 'multi',
    maxUses: opts.maxUses,
    fulfillmentPolicy: opts.fulfillmentPolicy ?? 'partial-auto',
    multiUseDistribution: opts.multiUseDistribution ?? 'fewest-keys',
  });
  await insertLicenseItems(db, crypto, {
    productId: product.id,
    count: opts.keys,
    tag: TAG,
    maxUses: opts.maxUses,
    payloadPrefix: 'MAK',
  });
  const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
  await productsService.createMapping({ siteId: site.id, productId: product.id, remoteProductId });

  const siteObj = { id: site.id } as Site;
  const makeDto = (qty: number): CreateOrderRequest => ({
    remoteOrderId: `ord-${randomUUID().slice(0, 8)}`,
    customerEmail: `${TAG}@example.test`,
    lines: [{ remoteLineId: 'line-1', remoteProductId, qty }],
  });
  return { site: siteObj, productId: product.id, makeDto };
}

/**
 * Ürünün anahtarları — DAİMA `seq` (ekleme sırası) ile sıralı okunur.
 * Dizi sırasına (INSERT ... RETURNING) GÜVENİLMEZ: FEFO iddiasını doğrulayan sıra
 * atama sorgusunun kullandığı sıradır (`expires_at, created_at, seq`), o da burada `seq`e iner.
 */
async function keysOf(productId: string) {
  return db
    .select({
      id: licenseItems.id,
      useCount: licenseItems.useCount,
      maxUses: licenseItems.maxUses,
      status: licenseItems.status,
      assignedAt: licenseItems.assignedAt,
      seq: licenseItems.seq,
    })
    .from(licenseItems)
    .where(eq(licenseItems.productId, productId))
    .orderBy(asc(licenseItems.seq));
}

/** Siparişin atama satırları (hangi anahtardan kaç birim). */
async function assignmentsOf(orderId: string) {
  return db
    .select({
      id: assignments.id,
      licenseItemId: assignments.licenseItemId,
      units: assignments.units,
      status: assignments.status,
    })
    .from(assignments)
    .where(eq(assignments.orderId, orderId));
}

/**
 * Bu blok VARSAYILAN dağıtım politikasının (`fewest-keys` — "sipariş başına en az anahtar")
 * sözleşmesidir. Ürün bazlı ikinci politika (`one-per-key`) sonradan eklendi; bu testler
 * PARAMETRELENMEDİ, çünkü varsayılan davranış DEĞİŞMEDİ — yeni politikanın onu bozmadığının
 * kanıtı olarak olduğu gibi durmaları gerekiyor. Yeni politikanın testleri dosyanın sonunda.
 */
describe('MAK/çok kullanımlık satış yolu — VARSAYILAN politika (fewest-keys)', () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL tanımlı değil — entegrasyon testleri gerçek PostgreSQL gerektirir.',
      );
    }
  });

  // NOT: temizlik/bağlantı kapatma DOSYA KÖKÜNDEDİR (dosyanın en altı). Buradaki bir
  // `afterAll(end)` ikinci describe'ın testlerinden ÖNCE koşar ve onları "bağlantı kapalı"
  // hatasıyla düşürürdü (Vitest'te root afterAll TÜM describe'lardan sonra çalışır).
  // maintenance.reconcile-expiry.test.ts aynı tuzağı aynı gerekçeyle belgeliyor.

  it('(a1) kısmi kapasite: qty=3 → TEK atama (units=3), kalem hâlâ available', async () => {
    // 2 anahtar × 5 kullanım = 10 birim kapasite; 3 birim isteniyor.
    const { site, productId, makeDto } = await makScenario({ keys: 2, maxUses: 5 });

    const { httpStatus, body } = await orders.createOrder(site, makeDto(3));

    expect(httpStatus).toBe(201);
    expect(body.status).toBe('fulfilled');
    // KRİTİK AYRIM (tek-kullanımlıktan farkı): 3 BİRİM tek ANAHTARdan gelir → 1 atama, units=3.
    // Tek-kullanımlıkta bu 3 ayrı atama olurdu.
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0]!.units).toBe(3);
    expect(body.lines[0]).toMatchObject({ status: 'fulfilled', requestedQty: 3, fulfilledQty: 3 });

    const rows = await assignmentsOf(body.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.units).toBe(3);

    const keys = await keysOf(productId);
    expect(keys).toHaveLength(2);
    // İlk anahtardan 3 birim düştü; kapasite KALDIĞI için kalem hâlâ satılabilir ('available').
    expect(keys[0]!.useCount).toBe(3);
    expect(keys[0]!.status).toBe('available');
    // Teslim damgası MAK'ta da basılır (envanterde "teslim tarihi" boş kalmamalı).
    expect(keys[0]!.assignedAt).not.toBeNull();
    // İkinci anahtara hiç dokunulmadı.
    expect(keys[1]!.useCount).toBe(0);
    expect(keys[1]!.status).toBe('available');
    expect(keys[1]!.assignedAt).toBeNull();
  });

  it('(a2) tek anahtar tercihi: 3+4 → talebi TEK BAŞINA karşılayan anahtardan TEK atama', async () => {
    const { site, productId, makeDto } = await makScenario({ keys: 2, maxUses: 5 });

    const first = await orders.createOrder(site, makeDto(3));
    expect(first.body.lines[0]!.fulfilledQty).toBe(3);

    // İlk anahtarda 2 kaldı, ikinci anahtar boş (5). 4 birimlik talep:
    // ESKİ davranış 2+2 diye BÖLÜYORDU → müşteri iki anahtar alıyor ve hangisini kaç kez
    // etkinleştirebileceğini bilmiyordu. YENİ kural: talebi tek başına karşılayan anahtar
    // (ikinci) seçilir → TEK anahtar, TEK atama. (assign.ts: "tek anahtar tercihi".)
    const second = await orders.createOrder(site, makeDto(4));

    expect(second.httpStatus).toBe(201);
    expect(second.body.status).toBe('fulfilled');
    expect(second.body.assignments).toHaveLength(1);
    expect(second.body.assignments[0]!.units).toBe(4);
    expect(second.body.lines[0]).toMatchObject({ status: 'fulfilled', fulfilledQty: 4 });

    const keys = await keysOf(productId);
    const [k1, k2] = keys;
    // İlk anahtara DOKUNULMADI (parçası duruyor); talep ikinci anahtardan tek parça karşılandı.
    expect(k1!.useCount).toBe(3);
    expect(k1!.status).toBe('available');
    expect(k2!.useCount).toBe(4);
    expect(k2!.status).toBe('available');

    const rows = await assignmentsOf(second.body.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.licenseItemId).toBe(k2!.id);
    expect(rows[0]!.units).toBe(4);
  });

  it('(a2b) hiçbir anahtar tek başına yetmiyorsa TAŞMA korunur (FEFO/seq ile doldur-taşır)', async () => {
    const { site, productId, makeDto } = await makScenario({ keys: 2, maxUses: 5 });

    // Her iki anahtarı da kısmen tüket: 3 → k1(3/5), sonra 3 → k2(3/5) (tek anahtar tercihi).
    await orders.createOrder(site, makeDto(3));
    await orders.createOrder(site, makeDto(3));

    // Artık kalan 2 + 2 = 4; 4 birimlik talebi HİÇBİR anahtar tek başına karşılayamaz →
    // eski davranış aynen: FEFO/seq ilk anahtar doldurulur, artan sonrakine taşar.
    const third = await orders.createOrder(site, makeDto(4));

    expect(third.httpStatus).toBe(201);
    expect(third.body.assignments).toHaveLength(2);
    expect(third.body.lines[0]).toMatchObject({ status: 'fulfilled', fulfilledQty: 4 });

    const keys = await keysOf(productId);
    const [k1, k2] = keys;
    expect(k1!.useCount).toBe(5);
    expect(k1!.status).toBe('depleted');
    expect(k2!.useCount).toBe(5);
    expect(k2!.status).toBe('depleted');

    const rows = await assignmentsOf(third.body.orderId);
    const byItem = new Map(rows.map((r) => [r.licenseItemId, r.units]));
    expect(byItem.get(k1!.id)).toBe(2);
    expect(byItem.get(k2!.id)).toBe(2);
  });

  it('(a2c) parça kapasite çürümez: küçük talep, yarım kalmış anahtarı FIFO ile ÖNCE seçer', async () => {
    const { site, productId, makeDto } = await makScenario({ keys: 2, maxUses: 5 });

    // k1 → 4/5 (1 boş kaldı), sonra 4 birim → k2'den (tek anahtar tercihi) 4/5.
    await orders.createOrder(site, makeDto(4));
    await orders.createOrder(site, makeDto(4));

    // 1 birimlik talebi İKİ anahtar da tek başına karşılayabilir → eşitliği FIFO çözer:
    // ÖNCE girilen (k1) seçilir ve parça kapasite kapanır ('depleted').
    const small = await orders.createOrder(site, makeDto(1));
    expect(small.body.assignments).toHaveLength(1);

    const keys = await keysOf(productId);
    const [k1, k2] = keys;
    expect(k1!.useCount).toBe(5);
    expect(k1!.status).toBe('depleted');
    expect(k2!.useCount).toBe(4);

    const rows = await assignmentsOf(small.body.orderId);
    expect(rows[0]!.licenseItemId).toBe(k1!.id);
  });

  it('(a3) kapasiteden fazla talep: 11 istendi / 10 kapasite → 10 teslim, KAPASİTE AŞILMAZ', async () => {
    // Bu dosyanın çekirdek invaryantı: MAK'ta aşırı-satış = aynı aktivasyonu iki müşteriye satmak.
    const { site, productId, makeDto } = await makScenario({ keys: 2, maxUses: 5 });

    const { httpStatus, body } = await orders.createOrder(site, makeDto(11));

    expect(httpStatus).toBe(207);
    expect(body.status).toBe('partial');
    expect(body.lines[0]).toMatchObject({ status: 'partial', requestedQty: 11, fulfilledQty: 10 });

    // Teslim edilen BİRİM toplamı tam kapasite kadar — ne fazla ne eksik.
    const rows = await assignmentsOf(body.orderId);
    const grantedUnits = rows.reduce((s, r) => s + r.units, 0);
    expect(grantedUnits).toBe(10);

    const keys = await keysOf(productId);
    // Hiçbir anahtar kendi tavanını AŞMADI (satır bazında invaryant).
    for (const k of keys) {
      expect(k.useCount).toBeLessThanOrEqual(k.maxUses);
      expect(k.useCount).toBe(5);
      expect(k.status).toBe('depleted');
    }
    // Toplam defter tutar: Σ use_count == Σ max_uses == teslim edilen birim.
    const totalUsed = keys.reduce((s, k) => s + k.useCount, 0);
    const totalCapacity = keys.reduce((s, k) => s + k.maxUses, 0);
    expect(totalUsed).toBe(totalCapacity);
    expect(totalUsed).toBe(grantedUnits);
  });

  it('(a4) kapasite tükendikten sonra yeni sipariş → 0 atama, satır pending (over-fulfillment yok)', async () => {
    // Tek anahtar × 2 kullanım; ilk sipariş kapasiteyi bitirir.
    const { site, productId, makeDto } = await makScenario({ keys: 1, maxUses: 2 });

    const first = await orders.createOrder(site, makeDto(2));
    expect(first.body.lines[0]!.fulfilledQty).toBe(2);
    const [depleted] = await keysOf(productId);
    expect(depleted!.status).toBe('depleted');
    expect(depleted!.useCount).toBe(2);

    // Stok yok → sipariş KAYBOLMAZ ama hiçbir birim teslim edilmez.
    const second = await orders.createOrder(site, makeDto(1));

    expect(second.httpStatus).toBe(202);
    expect(second.body.status).toBe('pending');
    expect(second.body.assignments).toHaveLength(0);
    expect(second.body.lines[0]).toMatchObject({ status: 'pending', fulfilledQty: 0 });

    expect(await assignmentsOf(second.body.orderId)).toHaveLength(0);
    // Kapasite defteri DEĞİŞMEDİ — tükenmiş anahtardan "eksiye" düşülmedi.
    const [after] = await keysOf(productId);
    expect(after!.useCount).toBe(2);
    expect(after!.status).toBe('depleted');

    // Satır DB'de gerçekten pending (yanıt ile defter ayrışmıyor).
    const [line] = await db
      .select({ status: orderLines.status, fulfilledQty: orderLines.fulfilledQty })
      .from(orderLines)
      .where(eq(orderLines.orderId, second.body.orderId))
      .limit(1);
    expect(line!.status).toBe('pending');
    expect(line!.fulfilledQty).toBe(0);

    // Ürün genelinde toplam teslim edilen birim = toplam kapasite (aşım yok).
    const [agg] = (await db.execute<{ used: string }>(sql`
      SELECT coalesce(sum(use_count), 0)::text AS used FROM license_items
      WHERE product_id = ${productId}
    `)) as unknown as Array<{ used: string }>;
    expect(Number(agg!.used)).toBe(2);
  });

  /*
   * (a4) ALL-OR-NOTHING + MAK → `releaseAllocations` KÜME-TABANLI yolunun asıl aritmetiği.
   *
   * NEDEN EKLENDİ (çürütme denetiminin bulduğu boşluk): `releaseAllocations` tek `UPDATE …
   * FROM (VALUES …)` ifadesine çevrildi, ama testlerin hiçbiri onu MAK ürününde koşturmuyordu —
   * `makScenario` `fulfillmentPolicy` parametresini kabul ettiği hâlde dört çağrısı da
   * varsayılan `partial-auto` veriyordu. Sonuç: `GREATEST(0, use_count − v.units)` aritmetiği,
   * `assigned_at`'in KORUNDUĞU dal ve İKİ FARKLI anahtar için toplu VALUES geri verimi hiç
   * çalıştırılmıyordu. Tek-kullanımlıkta `use_count` hep 0 olduğu için o yol bunları kanıtlamaz.
   *
   * Kurulum: 2 anahtar × 5 = 10 kapasite; önce 7 birim satılır (5 + 2 → İKİ anahtar), sonra
   * all-or-nothing satırda 6 birim istenir. Kalan 3 < 6 → hiçbir şey teslim edilmez ve o turda
   * ayrılan 3 birim (2 + 1, iki AYRI anahtardan) tek ifadeyle geri verilmelidir.
   */
  it('(a4) all-or-nothing + MAK: karşılanamayan satır İKİ anahtarın kapasitesini de tam geri verir', async () => {
    const { site, productId, makeDto } = await makScenario({
      keys: 2,
      maxUses: 5,
      fulfillmentPolicy: 'all-or-nothing',
    });

    // 1) 7 birim: 1. anahtar 5 (tükendi), 2. anahtar 2.
    const first = await orders.createOrder(site, makeDto(7));
    expect(first.body.lines[0]!.fulfilledQty).toBe(7);
    const afterFirst = await keysOf(productId);
    expect(afterFirst.map((k) => k.useCount)).toEqual([5, 2]);
    expect(afterFirst[0]!.status).toBe('depleted');
    const key2AssignedAt = afterFirst[1]!.assignedAt;
    expect(key2AssignedAt).not.toBeNull();

    // 2) 6 birim isteniyor ama yalnız 3 kaldı → all-or-nothing: HİÇBİR ŞEY teslim edilmez.
    const second = await orders.createOrder(site, makeDto(6));
    expect(second.body.lines[0]!.fulfilledQty).toBe(0);
    expect(second.body.assignments).toHaveLength(0);

    // 3) KAPASİTE TAM GERİ DÖNDÜ — bu turda ayrılan 3 birim (2. anahtardan 3) iade edildi.
    const afterSecond = await keysOf(productId);
    expect(afterSecond.map((k) => k.useCount)).toEqual([5, 2]);

    // 4) `assigned_at` KORUNDU: 2. anahtar hâlâ BAŞKA müşterilere teslim edilmiş durumda
    //    (use_count > 0) → "ilk teslim" damgası silinmemeli. Eski (koşulsuz NULL'layan)
    //    davranış envanterde teslim tarihini boşaltıyordu.
    expect(afterSecond[1]!.assignedAt).not.toBeNull();
    //    Tükenmiş 1. anahtar geri verimden ETKİLENMEDİ (o tura hiç girmedi).
    expect(afterSecond[0]!.status).toBe('depleted');
    expect(afterSecond[0]!.assignedAt).not.toBeNull();

    // 5) Ürün genelinde aşım yok.
    const [agg] = (await db.execute<{ used: string }>(sql`
      SELECT coalesce(sum(use_count), 0)::text AS used FROM license_items
      WHERE product_id = ${productId}
    `)) as unknown as Array<{ used: string }>;
    expect(Number(agg!.used)).toBe(7);
  });

  /*
   * (a5) EŞİTSİZ birim dağılımı → `assignmentId ↔ units` eşleşmesi.
   *
   * NEDEN EKLENDİ: toplu INSERT'te atama id'leri `licenseItemId` üzerinden eşleniyor
   * (RETURNING'in giriş sırasını koruduğu YAZILI garanti değil). Mevcut MAK testlerinde
   * birimler her zaman EŞİTTİ ({2,2}, {5,5}) — bir eşleşme hatası görünmezdi. Burada
   * dağılım bilerek eşitsiz ({5,2}): yanıttaki her atamanın `units` değeri, DB'deki AYNI
   * id'nin `units` değeriyle birebir tutmalı.
   */
  it('(a5) eşitsiz dağılım: yanıttaki her assignmentId, DB satırıyla aynı units taşır', async () => {
    const { site, productId, makeDto } = await makScenario({ keys: 2, maxUses: 5 });

    const res = await orders.createOrder(site, makeDto(7)); // 5 + 2 → eşitsiz
    expect(res.httpStatus).toBe(201);
    expect(res.body.assignments).toHaveLength(2);
    expect(res.body.assignments.map((a) => a.units).sort((x, y) => x - y)).toEqual([2, 5]);

    // Yanıttaki id'ler TEKİL olmalı (mükerrer id, kayıp bir atamanın işaretiydi).
    const ids = res.body.assignments.map((a) => a.assignmentId);
    expect(new Set(ids).size).toBe(2);

    // Her id'nin DB'deki units'i yanıtla AYNI mı (eşleşme gerçekten doğru mu).
    const rows = await assignmentsOf(res.body.orderId);
    const dbUnitsById = new Map(rows.map((r) => [r.id, r.units]));
    for (const a of res.body.assignments) {
      expect(dbUnitsById.get(a.assignmentId)).toBe(a.units);
    }

    // Kapasite dağılımı da eşitsiz olmalı (kurulum gerçekten amaçlanan şekli üretti mi).
    const keys = await keysOf(productId);
    expect(keys.map((k) => k.useCount)).toEqual([5, 2]);
  });
});

/**
 * MAK DAĞITIMI: `one-per-key` (ürün ayarı) — "her birimi AYRI anahtardan ver".
 *
 * NEDEN VAR (işletme kararı): yukarıdaki testler VARSAYILAN politikayı (`fewest-keys`,
 * "sipariş başına en az anahtar") kilitler. Bazı ürünlerde tersine ihtiyaç var: 3 birim
 * alındıysa ve stokta 3 uygun anahtar varsa müşteriye 3 AYRI anahtar × 1 hak gitsin; ayrı
 * anahtar yetmezse kalan talep AYNEN eski doldurma davranışıyla tamamlansın.
 *
 * ÖDÜN (bilinçli, ürün bazında opt-in): müşterinin eline geçen her fazladan anahtar, o
 * anahtarın KALAN kapasitesi kadar fazladan aşırı-etkinleştirme yüzeyidir.
 */
describe('MAK dağıtımı: one-per-key (ürün ayarı)', () => {
  it('(b1) 3 anahtar / qty=3 → 3 AYRI atama, her biri units=1', async () => {
    const { site, productId, makeDto } = await makScenario({
      keys: 3,
      maxUses: 5,
      multiUseDistribution: 'one-per-key',
    });

    const { httpStatus, body } = await orders.createOrder(site, makeDto(3));

    expect(httpStatus).toBe(201);
    expect(body.status).toBe('fulfilled');
    // VARSAYILAN politikada bu TEK atama (units=3) olurdu — asıl davranış farkı budur.
    expect(body.assignments).toHaveLength(3);
    expect(body.assignments.map((a) => a.units)).toEqual([1, 1, 1]);

    const keys = await keysOf(productId);
    expect(keys.map((k) => k.useCount)).toEqual([1, 1, 1]);
    // Hepsi hâlâ satılabilir (kapasite 5, yalnız 1 düştü) ve teslim damgası basıldı.
    expect(keys.every((k) => k.status === 'available')).toBe(true);
    expect(keys.every((k) => k.assignedAt !== null)).toBe(true);
  });

  it('(b2) 5 anahtar / qty=5 → 5 AYRI atama', async () => {
    const { site, productId, makeDto } = await makScenario({
      keys: 5,
      maxUses: 5,
      multiUseDistribution: 'one-per-key',
    });

    const { body } = await orders.createOrder(site, makeDto(5));

    expect(body.assignments).toHaveLength(5);
    expect(body.assignments.map((a) => a.units)).toEqual([1, 1, 1, 1, 1]);
    const keys = await keysOf(productId);
    expect(keys.map((k) => k.useCount)).toEqual([1, 1, 1, 1, 1]);
  });

  /** ASIL GERİ DÜŞÜŞ KANITI: ayrı anahtar YOKSA politika tek anahtardan doldurmaya döner. */
  it('(b3) TEK anahtar / qty=6 → 1 atama, units=6 (doldurma dalına düşer)', async () => {
    const { site, productId, makeDto } = await makScenario({
      keys: 1,
      maxUses: 10,
      multiUseDistribution: 'one-per-key',
    });

    const { httpStatus, body } = await orders.createOrder(site, makeDto(6));

    expect(httpStatus).toBe(201);
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0]!.units).toBe(6);

    const keys = await keysOf(productId);
    expect(keys[0]!.useCount).toBe(6);
    expect(keys[0]!.status).toBe('available');
  });

  it('(b4) 3 anahtar / qty=5 → önce 1er, kalan 2 doldurmayla; toplam ASLA aşılmaz', async () => {
    const { site, productId, makeDto } = await makScenario({
      keys: 3,
      maxUses: 5,
      multiUseDistribution: 'one-per-key',
    });

    const { body } = await orders.createOrder(site, makeDto(5));

    expect(body.assignments).toHaveLength(3);
    const units = body.assignments.map((a) => a.units).sort((x, y) => y - x);
    expect(units).toEqual([3, 1, 1]); // 1+1+1 (spread) + 2 (doldurma, FEFO/FIFO ilk anahtara)
    expect(units.reduce((s, u) => s + u, 0)).toBe(5);

    const keys = await keysOf(productId);
    expect(keys.reduce((s, k) => s + k.useCount, 0)).toBe(5);
    expect(keys.every((k) => k.useCount <= k.maxUses)).toBe(true);
  });

  it('(b5) kapasite yetmezse kısmi teslim; kapasite AŞILMAZ', async () => {
    // 2 anahtar × 2 kapasite = 4 birim; 6 isteniyor.
    const { site, productId, makeDto } = await makScenario({
      keys: 2,
      maxUses: 2,
      multiUseDistribution: 'one-per-key',
    });

    const { httpStatus, body } = await orders.createOrder(site, makeDto(6));

    expect(httpStatus).toBe(207);
    expect(body.lines[0]).toMatchObject({ requestedQty: 6, fulfilledQty: 4 });

    const keys = await keysOf(productId);
    expect(keys.map((k) => k.useCount)).toEqual([2, 2]);
    expect(keys.every((k) => k.status === 'depleted')).toBe(true); // spread dalında da çalışır
    expect(keys.reduce((s, k) => s + k.useCount, 0)).toBe(4);
  });

  /**
   * FEFO KORUNUYOR — bu testin varlık sebebi bir TASARIM KARARINI kilitlemektir.
   * Spread'i `use_count ASC` sıralamasıyla yazmak dışlama listesini gereksiz kılardı ama
   * FEFO'yu ikinci sıraya düşürürdü: süresi yarın dolacak bir anahtar, hiç kullanılmamış
   * süresiz bir anahtara YENİLİRDİ. Bu test o tasarımda KIRMIZI olur.
   */
  it('(b6) spread turunda FEFO korunur: süresi en yakın anahtar ÖNCE seçilir', async () => {
    const site = await createSite(db, crypto, { tag: TAG });
    const product = await createProduct(db, {
      tag: TAG,
      kind: 'key',
      usageMode: 'multi',
      maxUses: 5,
      multiUseDistribution: 'one-per-key',
    });
    // ÖNCE süresiz anahtar, SONRA süresi yakın olan → FIFO/seq sırası FEFO'nun TERSİ.
    // Böylece "FEFO gerçekten uygulanıyor mu" sorusu seq sırasından ayrışır.
    await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag: TAG,
      maxUses: 5,
      payloadPrefix: 'MAK-SURESIZ',
    });
    await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag: TAG,
      maxUses: 5,
      payloadPrefix: 'MAK-YAKIN',
      expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    });
    const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
    await productsService.createMapping({
      siteId: site.id,
      productId: product.id,
      remoteProductId,
    });

    const { body } = await orders.createOrder({ id: site.id } as Site, {
      remoteOrderId: `ord-${randomUUID().slice(0, 8)}`,
      customerEmail: `${TAG}@example.test`,
      lines: [{ remoteLineId: 'line-1', remoteProductId, qty: 1 }],
    });

    const keys = await keysOf(product.id); // seq sırası: [süresiz, yakın]
    expect(body.assignments).toHaveLength(1);
    // FEFO: seq'te SONRA gelen (süresi yakın) anahtar seçilmeliydi.
    expect(keys[0]!.useCount).toBe(0);
    expect(keys[1]!.useCount).toBe(1);
  });

  /**
   * all-or-nothing + one-per-key: karşılanamayan satır K AYRI anahtarın kapasitesini de
   * TAM geri vermeli. `releaseAllocations` küme tabanlı çalışır; spread K ayrı satır ürettiği
   * için bu yol varsayılan politikada test edilenden farklı bir şekle girer.
   */
  it('(b7) all-or-nothing: karşılanamayan satır TÜM anahtarların kapasitesini geri verir', async () => {
    const { site, productId, makeDto } = await makScenario({
      keys: 3,
      maxUses: 1,
      multiUseDistribution: 'one-per-key',
      fulfillmentPolicy: 'all-or-nothing',
    });

    const { body } = await orders.createOrder(site, makeDto(4)); // 3 kapasite var, 4 isteniyor

    expect(body.lines[0]!.fulfilledQty).toBe(0);
    expect(body.assignments).toHaveLength(0);

    const keys = await keysOf(productId);
    expect(keys.map((k) => k.useCount)).toEqual([0, 0, 0]);
    // depleted → available geri dönüşü ve damga temizliği spread dalında da çalışmalı.
    expect(keys.every((k) => k.status === 'available')).toBe(true);
    expect(keys.every((k) => k.assignedAt === null)).toBe(true);
  });
});

// Dosya kapsamı (root) temizlik — TÜM describe blokları bittikten SONRA koşar.
afterAll(async () => {
  await cleanupByTag(db, TAG);
  await end();
});
