import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { OrdersService } from '../../src/orders/orders.service';
import { ProductsService } from '../../src/products/products.service';
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
  type Db,
} from './_helpers';
import type { CryptoService } from '../../src/crypto/crypto.service';

/**
 * ENTEGRASYON — süre-bitişinin GÖRÜNÜRLÜĞÜ ve REVEAL kapısı (§7/§11), gerçek PG.
 *
 * İki denetim bulgusunun regresyon kilidi:
 *  · O3 — `getDeliveries.expiredHidden` bayrağı `status='active'` şartına bağlıydı; oysa
 *    ExpiryService sweep'i tam o satırları 'expired' yapar → bayrak yalnız sweep'in
 *    GECİKTİĞİ ≤5 dk penceresinde doğruydu. Süresi dolan müşteri boş liste + SIFIR açıklama
 *    görüyordu. Bayrak artık KALICI durumu (active + expired) kapsar.
 *  · O4 — `siteReveal` yalnız `status`a bakıyordu; sweep durursa (prod'da yetim scheduler'lar
 *    görüldü) süresi geçmiş `hide` hesabının parolası mağaza panelindeki "Göster" ile düz
 *    metin okunabiliyordu — My Account ve mail onu bilinçli gizlerken.
 *
 * Nest ayağa KALDIRILMAZ (dosya deseni: deliveries.expiry-filter.test.ts): servisler elle
 * new'lenir, kullanılmayan bağımlılıklar güvenli stub'tır.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let orders: OrdersService;
let admin: AdminOrdersService;
let site: { id: string };

const past = () => new Date(Date.now() - 60_000);
const future = () => new Date(Date.now() + 3_600_000);

/** Bir sipariş + tek atama kurar; atamanın durumu ve süresi senaryoya göre verilir. */
async function scenario(opts: {
  onExpiry: 'hide' | 'keep';
  validUntil: Date | null;
  status: 'active' | 'expired';
}) {
  const product = await createProduct(db, { tag, onExpiry: opts.onExpiry });
  const [itemId] = await insertLicenseItems(db, crypto, {
    productId: product.id,
    count: 1,
    tag,
    status: 'assigned',
  });
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
      licenseItemId: itemId!,
      status: opts.status,
      units: 1,
      validUntil: opts.validUntil,
      deliveredAt: new Date(),
    })
    .returning({ id: schema.assignments.id });
  return { ...order, assignmentId: asg!.id, productId: product.id };
}

describe('süre-bitişi görünürlüğü (O3) + site-scoped reveal kapısı (O4)', () => {
  beforeAll(async () => {
    const h = makeDb();
    db = h.db;
    end = h.end;
    crypto = makeCrypto();
    orders = new OrdersService(
      db as unknown as Database,
      {} as never,
      crypto as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    // siteReveal → reveal yalnız db + crypto kullanır (audit yazımı dahil); redis/mail/
    // fulfillment bu yolda ÇAĞRILMAZ → güvenli stub.
    admin = new AdminOrdersService(
      db as unknown as Database,
      {} as never,
      crypto as never,
      {} as never,
      {} as never,
    );
    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  // ── O3 ────────────────────────────────────────────────────────────────────────────

  it('sweep KOŞTUKTAN sonra da (status=expired) expiredHidden bayrağı KALIR', async () => {
    const s = await scenario({ onExpiry: 'hide', validUntil: past(), status: 'expired' });
    const res = await orders.getDeliveries({ id: site.id } as unknown as Site, s.orderId);
    expect(res.deliveries).toHaveLength(0); // payload gizli — doğru
    expect(res.expiredHidden).toBe(true); // ama SEBEBİ müşteriye söyleniyor
  });

  it('sweep GECİKMİŞKEN (status=active) bayrak zaten doğruydu — korunur', async () => {
    const s = await scenario({ onExpiry: 'hide', validUntil: past(), status: 'active' });
    const res = await orders.getDeliveries({ id: site.id } as unknown as Site, s.orderId);
    expect(res.expiredHidden).toBe(true);
  });

  it('keep ürününde bayrak YANMAZ (lisans süre sonrası da teslim edilir)', async () => {
    const s = await scenario({ onExpiry: 'keep', validUntil: past(), status: 'active' });
    const res = await orders.getDeliveries({ id: site.id } as unknown as Site, s.orderId);
    expect(res.deliveries).toHaveLength(1);
    expect(res.expiredHidden).toBe(false);
  });

  it('süresi gelecekte olan atamada bayrak YANMAZ', async () => {
    const s = await scenario({ onExpiry: 'hide', validUntil: future(), status: 'active' });
    const res = await orders.getDeliveries({ id: site.id } as unknown as Site, s.orderId);
    expect(res.expiredHidden).toBe(false);
  });

  // ── O4 ────────────────────────────────────────────────────────────────────────────

  it('sweep DURMUŞ olsa bile süresi geçmiş hide atamanın payloadı reveal EDİLEMEZ', async () => {
    const s = await scenario({ onExpiry: 'hide', validUntil: past(), status: 'active' });
    await expect(
      admin.siteReveal(
        { id: site.id } as unknown as Site,
        s.remoteOrderId,
        s.assignmentId,
        `wp:test@${tag}`,
      ),
    ).rejects.toThrow(/süresi doldu/i);
  });

  it('keep ürününde süresi geçmiş atama reveal EDİLEBİLİR (getDeliveries ile simetrik)', async () => {
    const s = await scenario({ onExpiry: 'keep', validUntil: past(), status: 'active' });
    const r = await admin.siteReveal(
      { id: site.id } as unknown as Site,
      s.remoteOrderId,
      s.assignmentId,
      `wp:test@${tag}`,
    );
    expect(r).toBeTruthy();
  });

  it('süresiz (validUntil=null) atama reveal EDİLEBİLİR', async () => {
    const s = await scenario({ onExpiry: 'hide', validUntil: null, status: 'active' });
    const r = await admin.siteReveal(
      { id: site.id } as unknown as Site,
      s.remoteOrderId,
      s.assignmentId,
      `wp:test@${tag}`,
    );
    expect(r).toBeTruthy();
  });
});

/**
 * ENTEGRASYON — Y2: hesap ürünü payload şeması + `kind` mevcut stok VARKEN yıkıcı biçimde
 * değiştirilemez (kapasite guard'ının aynı deseni). Alan EKLEME / label / required serbest.
 */
describe('products.update — payloadSchema + kind koruması (Y2)', () => {
  const tag2 = randomUUID().slice(0, 8);
  let db2: Db;
  let end2: () => Promise<void>;
  let crypto2: CryptoService;
  let svc: ProductsService;

  const schemaV1 = [
    { key: 'username', label: 'Kullanıcı', secret: false, required: true },
    { key: 'password', label: 'Parola', secret: true, required: true },
  ];

  beforeAll(async () => {
    const h = makeDb();
    db2 = h.db;
    end2 = h.end;
    crypto2 = makeCrypto();
    svc = new ProductsService(db2 as unknown as Database);
  });

  afterAll(async () => {
    await cleanupByTag(db2, tag2);
    await end2();
  });

  /** Canlı (available) kalemi olan bir hesap ürünü. */
  async function accountProductWithStock() {
    const p = await createProduct(db2, { tag: tag2, kind: 'account', payloadSchema: schemaV1 });
    await insertLicenseItems(db2, crypto2, { productId: p.id, count: 2, tag: tag2 });
    return p;
  }

  it('alan KALDIRMA stok varken 409 verir ve etkilenen kalem sayısını söyler', async () => {
    const p = await accountProductWithStock();
    await expect(svc.update(p.id, { payloadSchema: [schemaV1[1]!] as never })).rejects.toThrow(
      /2 canlı lisans kaydı/,
    );
  });

  it('secret: true → false stok varken 409 verir (geriye dönük ifşa)', async () => {
    const p = await accountProductWithStock();
    await expect(
      svc.update(p.id, {
        payloadSchema: [
          schemaV1[0]!,
          { key: 'password', label: 'Parola', secret: false, required: true },
        ] as never,
      }),
    ).rejects.toThrow(/gizliliği kaldırılan/i);
  });

  it('kind değişimi stok varken 409 verir (payload çözüm yolu değişir)', async () => {
    const p = await accountProductWithStock();
    await expect(svc.update(p.id, { kind: 'key' })).rejects.toThrow(/ürün tipi/i);
  });

  it('alan EKLEME + label/required değişimi stok VARKEN de serbesttir', async () => {
    const p = await accountProductWithStock();
    const next = [
      { key: 'username', label: 'E-posta / Kullanıcı adı', secret: false, required: false },
      { key: 'password', label: 'Parola', secret: true, required: true },
      { key: 'totp', label: '2FA yedek kodu', secret: true, required: false },
    ];
    const row = await svc.update(p.id, { payloadSchema: next as never });
    expect((row.payloadSchema as typeof next).map((f) => f.key)).toEqual([
      'username',
      'password',
      'totp',
    ]);
  });

  it('CANLI kalem yoksa yıkıcı değişiklik serbesttir (ürün sonsuza dek kilitlenmez)', async () => {
    const p = await createProduct(db2, { tag: tag2, kind: 'account', payloadSchema: schemaV1 });
    const [itemId] = await insertLicenseItems(db2, crypto2, {
      productId: p.id,
      count: 1,
      tag: tag2,
    });
    // Kalemi ÖLDÜR (karantina) → guard artık saymaz.
    await db2
      .update(schema.licenseItems)
      .set({ status: 'quarantined' })
      .where(eq(schema.licenseItems.id, itemId!));
    const row = await svc.update(p.id, { kind: 'key', payloadSchema: null as never });
    expect(row.kind).toBe('key');
  });
});
