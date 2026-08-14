import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateOrderRequest } from '@lisans/shared';
import { OrdersService } from '../../src/orders/orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { ProductsService } from '../../src/products/products.service';
import { assignments, licenseItems, type Site } from '../../src/db/schema';
import {
  cleanupByTag,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  makeDb,
} from './_helpers';

/**
 * ENTEGRASYON — MAK/ÇOK KULLANIMLIK EŞZAMANLILIK (kapasite aşımı = 0).
 *
 * NEDEN: `test/race/assignment.race.test.ts` yalnız TEK KULLANIMLIK yolu kanıtlıyor
 * (`assignAvailableSingleUse`: 100 sipariş × 50 stok → çifte atama 0). MAK yolu farklı bir
 * mekanizmadır: satır SEÇMEZ, kilitli TEK satırda sayaç artırır (`use_count += LEAST(want, kalan)`).
 * Oradaki güvence "aynı satır iki kez seçilemez" değil, "sayaç tavanı AŞAMAZ"dır ve bu hiç
 * doğrulanmamıştı. Aşım burada doğrudan AŞIRI-SATIŞ demektir: aynı aktivasyon iki müşteride.
 *
 * NEREYE KONDU: `test/integration/` — bu dosya servisleri elle new'leyip gerçek `createOrder`
 * transaction'larını yarıştırır ve `_helpers` seed/temizlik desenine ihtiyaç duyar; aynı desendeki
 * eşzamanlılık testleri (purchase-orders.receive "eşzamanlı teslim-al", sales-quota-hardcap TOCTOU)
 * de burada duruyor. `test/race/` dosyaları ise `_helpers`'ı hiç kullanmayan, tek fonksiyonu
 * ham bağlantılarla döven mikro-yarışlardır.
 *
 * İKİ FAZ:
 *   Faz 1 (yarış)  — 5 eşzamanlı sipariş × 3 birim = 15 talep, kapasite 10.
 *                    İnvaryant: tavan AŞILMAZ + defter ile teslimat BİREBİR tutar.
 *   Faz 2 (tahliye) — SKIP LOCKED yüzünden yarışta alınamayan kapasite KAYBOLMAMIŞ olmalı;
 *                    seri siparişlerle kalan çekilir ve büyük toplam TAM 10 çıkar.
 *
 * NEDEN İKİ FAZ: tek başına yarış fazında "toplam TAM 10" beklemek KIRILGAN olurdu — SKIP LOCKED
 * gereği kilitli anahtarı gören eşzamanlı istek onu ATLAR ve kapasite havuzda kalır (kayıp değil,
 * ertelenmiş). Doğru invaryant çifttir: hiçbir zaman AŞILMAZ (faz 1) ve hiçbir zaman KAYBOLMAZ (faz 2).
 */

const TAG = randomUUID().slice(0, 8);
const MAX_USES = 10;
const CONCURRENT_ORDERS = 5;
const UNITS_PER_ORDER = 3; // 5 × 3 = 15 talep > 10 kapasite

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

let site: Site;
let productId: string;
let remoteProductId: string;

const makeDto = (qty: number): CreateOrderRequest => ({
  remoteOrderId: `ord-${randomUUID().slice(0, 8)}`,
  customerEmail: `${TAG}@example.test`,
  lines: [{ remoteLineId: 'line-1', remoteProductId, qty }],
});

/** Ürünün TEK MAK anahtarının kapasite defteri. */
async function keyState() {
  const [row] = await db
    .select({
      id: licenseItems.id,
      useCount: licenseItems.useCount,
      maxUses: licenseItems.maxUses,
      status: licenseItems.status,
    })
    .from(licenseItems)
    .where(eq(licenseItems.productId, productId))
    .limit(1);
  return row!;
}

/** Ürüne ait TÜM atamaların birim toplamı (hangi siparişten geldiği fark etmez). */
async function grantedUnits(): Promise<number> {
  const rows = await db
    .select({ units: assignments.units, licenseItemId: assignments.licenseItemId })
    .from(assignments)
    .innerJoin(licenseItems, eq(assignments.licenseItemId, licenseItems.id))
    .where(eq(licenseItems.productId, productId));
  return rows.reduce((s, r) => s + r.units, 0);
}

describe('MAK eşzamanlılık: kapasite aşımı = 0 (entegrasyon)', () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL tanımlı değil — entegrasyon testleri gerçek PostgreSQL gerektirir.',
      );
    }
    const created = await createSite(db, crypto, { tag: TAG });
    // Kota KAPALI (salesDailyQuota null, dynamicQuotaEnabled false) → createOrder site başına
    // advisory-lock ALMAZ; istekler gerçekten paralel koşar ve yarış atama katmanında yaşanır.
    site = { id: created.id } as Site;

    const product = await createProduct(db, {
      tag: TAG,
      kind: 'key',
      usageMode: 'multi',
      maxUses: MAX_USES,
      fulfillmentPolicy: 'partial-auto',
    });
    productId = product.id;
    // TEK anahtar: tüm eşzamanlı istekler AYNI satır için yarışır (en sıkı senaryo).
    await insertLicenseItems(db, crypto, {
      productId,
      count: 1,
      tag: TAG,
      maxUses: MAX_USES,
      payloadPrefix: 'MAKRACE',
    });
    remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
    await productsService.createMapping({ siteId: site.id, productId, remoteProductId });
  });

  afterAll(async () => {
    await cleanupByTag(db, TAG);
    await end();
  });

  it(`${CONCURRENT_ORDERS} eşzamanlı sipariş × ${UNITS_PER_ORDER} birim / ${MAX_USES} kapasite → tavan aşılmaz, kapasite kaybolmaz`, async () => {
    // ── Faz 1: yarış ────────────────────────────────────────────────────────
    const settled = await Promise.allSettled(
      Array.from({ length: CONCURRENT_ORDERS }, () =>
        orders.createOrder(site, makeDto(UNITS_PER_ORDER)),
      ),
    );
    // Hiçbir istek HATA ile düşmemeli (deadlock/500 yok) — kısmi teslimat meşru sonuçtur.
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(rejected.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    const results = settled
      .filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof orders.createOrder>>> =>
        s.status === 'fulfilled',
      )
      .map((s) => s.value);

    const raceKey = await keyState();
    const raceGranted = await grantedUnits();

    // (1) TAVAN — asla aşılmaz. Aşım = aynı aktivasyonun iki müşteriye satılması.
    expect(raceKey.useCount).toBeLessThanOrEqual(MAX_USES);
    // (2) DEFTER ↔ TESLİMAT — sayaçta düşen birim ile müşterilere yazılan atama birimi BİREBİR.
    //     Ayrışma iki yönde de bozukluktur: fazlası hayali stok, eksiği sessiz kapasite sızıntısı.
    expect(raceGranted).toBe(raceKey.useCount);
    // (3) Kimse istediğinden FAZLA almadı ve yanıt ile defter çelişmiyor.
    for (const r of results) {
      const line = r.body.lines[0]!;
      expect(line.fulfilledQty).toBeLessThanOrEqual(UNITS_PER_ORDER);
      expect(line.fulfilledQty).toBeGreaterThanOrEqual(0);
      const rows = await db
        .select({ units: assignments.units })
        .from(assignments)
        .where(eq(assignments.orderId, r.body.orderId));
      expect(rows.reduce((s, x) => s + x.units, 0)).toBe(line.fulfilledQty);
    }
    // (4) Yanıtların toplamı = defter (hiçbir siparişe "verildi" denip yazılmamış birim yok).
    expect(results.reduce((s, r) => s + r.body.lines[0]!.fulfilledQty, 0)).toBe(raceKey.useCount);
    // Doluysa 'depleted', değilse hâlâ satılabilir — durum ile sayaç tutarlı.
    expect(raceKey.status).toBe(raceKey.useCount >= MAX_USES ? 'depleted' : 'available');

    // ── Faz 2: tahliye ──────────────────────────────────────────────────────
    // SKIP LOCKED yüzünden yarışta alınamayan kapasite HAVUZDA kalmalı. Seri (yarışsız)
    // siparişlerle kalan çekilir; birikmeli toplam TAM kapasiteye oturmalı.
    for (let i = 0; i < MAX_USES + 2; i++) {
      const res = await orders.createOrder(site, makeDto(1));
      const done = res.body.lines[0]!.fulfilledQty;
      expect(done === 0 || done === 1).toBe(true);
      if (done === 0) {
        // Kapasite bitti → sipariş kaybolmaz, pending kalır (over-fulfillment yok).
        expect(res.httpStatus).toBe(202);
        expect(res.body.status).toBe('pending');
      }
    }

    const finalKey = await keyState();
    const finalGranted = await grantedUnits();

    // Ne AŞILDI ne KAYBOLDU: tam kapasite kadar birim satıldı.
    expect(finalKey.useCount).toBe(MAX_USES);
    expect(finalGranted).toBe(MAX_USES);
    expect(finalKey.status).toBe('depleted');
  });
});
