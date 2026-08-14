import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * ENTEGRASYON — "satılabilir" tanımının TEK yüklem olması + "müşterilerde" ekseni.
 *
 * REGRESYON 1 (belgelenmiş "sayaç 7 / liste 12" ayrışması): stok TOPLAMLARI (availableCount,
 * products.list, düşük-stok alarmı, dashboard) süresi GEÇMİŞ kalemleri saymıyordu — çünkü
 * atanamazlar — ama envanter LİSTESİ ham `status='available'` süzüyordu. Aynı ürün için sayaç
 * "7", "Satılabilir" filtreli liste "12" satır gösteriyordu; operatör "neden teslim edilmiyor,
 * stok var" diye bakıyordu. İki tanım tek yükleme (assign.ts `notExpiredCond`) bağlandı.
 * Süresi geçmiş kalem KAYBOLMAZ: filtresiz listede `expired:true` bayrağıyla durur ve
 * 'expired' süzgeciyle DOĞRUDAN listelenir (aksi halde operatör onları hiç göremez ve
 * temizleyemez).
 *
 * REGRESYON 2 ("müşterilerde" ekseni): `holder='customer'` kalemin DURUMUNDAN değil CANLI
 * ATAMASINDAN türer ve canlı = active VEYA suspended'dır. Askıya daraltılmış bir yüklem
 * (yalnız 'active') askıdaki anahtarı "kimsede değil" gösterir — parti geri çekildikten
 * sonra "hangi anahtarları değiştirmem gerek" listesi eksik çıkar. Bu, projede üç kez
 * tekrarlayan H1 sınıfının sayım tarafındaki yüzüdür.
 */

const tag = randomUUID().slice(0, 8);
const ACTOR = 'panel:it-expiry-holder';

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let stock: StockService;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const configFake = { get: () => undefined } as never;
const autocompleteQueueFake = { add: async () => ({ id: 'fake' }) } as never;

const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000);
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

describe('satılabilir stok tanımı (süre) + müşterilerde ekseni', () => {
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
    // Liste görüntülemeleri 'reveal' audit satırı bırakır (§8) — bu koşuya özel aktörü temizle.
    await db.execute(sql`DELETE FROM audit_log WHERE actor = ${ACTOR}`);
    await cleanupByTag(db, tag);
    await end();
  });

  it('süresi GEÇMİŞ "available" kalem satılabilir listesinde ÇIKMAZ, expired süzgecinde ÇIKAR', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const [expiredId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      expiresAt: PAST,
      payloadPrefix: 'EXP-GECMIS',
    });
    const [freshId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      expiresAt: FUTURE,
      payloadPrefix: 'EXP-TAZE',
    });
    const [foreverId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      payloadPrefix: 'EXP-SURESIZ',
    });

    // Üçü de HAM durumda 'available' — fark yalnız expires_at'te.
    const raw = await db
      .select({ id: schema.licenseItems.id, status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.productId, product.id));
    expect(raw.every((r) => r.status === 'available')).toBe(true);

    const available = await stock.listLicenseItems(
      { productId: product.id, status: 'available', pageSize: 100 },
      ACTOR,
      true,
    );
    const availableIds = available.rows.map((r) => r.id);
    expect(availableIds).toEqual(expect.arrayContaining([freshId!, foreverId!]));
    // BİLDİRİLEN AYRIŞMANIN KENDİSİ: süresi geçmiş kalem "satılabilir" sayılmamalı.
    expect(availableIds).not.toContain(expiredId!);
    // Toplam da liste ile aynı yüklemden gelir (sayaç/liste asla ayrışmaz).
    expect(available.total).toBe(2);

    // Stok sayacı ile birebir aynı sonuç (iki tanım kalmadı).
    expect(await stock.availableCount(product.id)).toBe(2);

    const expiredList = await stock.listLicenseItems(
      { productId: product.id, status: 'expired', pageSize: 100 },
      ACTOR,
      true,
    );
    const expiredIds = expiredList.rows.map((r) => r.id);
    expect(expiredIds).toContain(expiredId!);
    expect(expiredIds).not.toContain(freshId!);
    expect(expiredIds).not.toContain(foreverId!);
  });

  it('filtresiz listede süresi geçmiş kalem DURUR ve `expired` bayrağı taşır', async () => {
    // Kaybolmamalı: operatör göremezse temizleyemez ve "stok var ama teslim olmuyor" der.
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const [expiredId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      expiresAt: PAST,
      payloadPrefix: 'EXP-BAYRAK',
    });
    const [freshId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      payloadPrefix: 'EXP-BAYRAK-TAZE',
    });

    const all = await stock.listLicenseItems({ productId: product.id, pageSize: 100 }, ACTOR, true);
    const byId = new Map(all.rows.map((r) => [r.id, r]));
    expect(all.rows).toHaveLength(2);

    const expiredRow = byId.get(expiredId!)!;
    expect(expiredRow.status).toBe('available'); // HAM durum değişmez
    expect(expiredRow.expired).toBe(true); // karar SUNUCUDA verilir (istemci saati değil)

    expect(byId.get(freshId!)!.expired).toBe(false);
  });

  it('holder=customer: AKTİF ve ASKIDAKİ atamalı kalemleri döndürür, ölü atamayı döndürmez', async () => {
    // Askıya daraltılırsa askıdaki anahtar "kimsede değil" görünür → geri çekme sonrası
    // değiştirilecekler listesi eksik çıkar (H1 sınıfının sayım tarafı).
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const site = await createSite(db, crypto, { tag });
    const ids = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 4,
      tag,
      payloadPrefix: 'HOLDER',
    });
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 3,
      tag,
    });

    const mk = async (
      licenseItemId: string,
      itemStatus: 'assigned' | 'quarantined',
      assignmentStatus: 'active' | 'suspended' | 'replaced',
    ) => {
      await db
        .update(schema.licenseItems)
        .set({ status: itemStatus })
        .where(eq(schema.licenseItems.id, licenseItemId));
      await db.insert(schema.assignments).values({
        orderId: order.orderId,
        lineId: order.lineId,
        licenseItemId,
        units: 1,
        status: assignmentStatus,
      });
    };
    await mk(ids[0]!, 'assigned', 'active');
    await mk(ids[1]!, 'assigned', 'suspended');
    await mk(ids[2]!, 'quarantined', 'replaced'); // iade/değişimde geri alınmış → ÖLÜ
    // ids[3] hiç atanmadı → stokta.

    const held = await stock.listLicenseItems(
      { productId: product.id, holder: 'customer', pageSize: 100 },
      ACTOR,
      true,
    );
    const heldIds = held.rows.map((r) => r.id);
    expect(heldIds).toEqual(expect.arrayContaining([ids[0]!, ids[1]!]));
    expect(heldIds).not.toContain(ids[2]!);
    expect(heldIds).not.toContain(ids[3]!);
    expect(held.total).toBe(2);
  });

  it('holder ekseni DURUM süzgecinden BAĞIMSIZDIR — kısmen satılmış MAK anahtarı ikisinde de çıkar', async () => {
    // MAK anahtarı kısmen satılmışken hâlâ status='available'dır; "müşterilerde mi?" sorusu
    // kalemin durumundan OKUNAMAZ. İki ekseni birleştiren her sadeleştirme bu satırı kaybeder.
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'multi',
      maxUses: 500,
    });
    const site = await createSite(db, crypto, { tag });
    const [itemId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      maxUses: 500,
      payloadPrefix: 'HOLDER-MAK',
    });
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 3,
      tag,
    });
    await db
      .update(schema.licenseItems)
      .set({ useCount: 3 })
      .where(eq(schema.licenseItems.id, itemId!));
    await db.insert(schema.assignments).values({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: itemId!,
      units: 3,
      status: 'active',
    });

    const held = await stock.listLicenseItems(
      { productId: product.id, holder: 'customer', pageSize: 100 },
      ACTOR,
      true,
    );
    expect(held.rows.map((r) => r.id)).toContain(itemId!);

    const available = await stock.listLicenseItems(
      { productId: product.id, status: 'available', pageSize: 100 },
      ACTOR,
      true,
    );
    expect(available.rows.map((r) => r.id)).toContain(itemId!);
    // Kalan kapasite doğru raporlanır (500 − 3).
    expect(available.rows.find((r) => r.id === itemId!)!.remainingUses).toBe(497);
  });
});
