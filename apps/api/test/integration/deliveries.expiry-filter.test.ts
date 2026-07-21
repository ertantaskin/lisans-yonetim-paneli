import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  type Db,
} from './_helpers';
import type { CryptoService } from '../../src/crypto/crypto.service';

/**
 * ENTEGRASYON — OrdersService.getDeliveries SAVUNMA amaçlı süre filtresi (§11), gerçek PG.
 *
 * ExpiryService cron'u gecikse (atama hâlâ status='active') BİLE, onExpiry='hide' ürünün süresi
 * geçmiş payload'ı teslimat yanıtında SIZMAMALI. SQL filtresi: valid_until IS NULL VEYA > now()
 * VEYA products.on_expiry='keep'. keep ürün süre sonrası görünür ama `expired` bayrağı taşır.
 *
 * Nest ayağa KALDIRILMAZ: OrdersService elle new'lenir; getDeliveries YALNIZ this.db + this.crypto
 * kullanır (mail/webhook/fulfillment/adminOrders yollarına DOKUNMAZ) → bu bağımlılıklar stub.
 * site sadece .id ile okunur (partial cast). Her assert kendi tag'iyle seed edip afterAll'da
 * yalnız kendi eklediklerini siler.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let svc: OrdersService;
let siteId: string;

/** Aktif atama ekler (expiry cron KOŞMAMIŞ senaryosu: status='active' kalır). */
async function insertActiveAssignment(opts: {
  orderId: string;
  lineId: string;
  licenseItemId: string;
  validUntil: Date | null;
}): Promise<string> {
  const [row] = await db
    .insert(schema.assignments)
    .values({
      orderId: opts.orderId,
      lineId: opts.lineId,
      licenseItemId: opts.licenseItemId,
      status: 'active',
      units: 1,
      validUntil: opts.validUntil,
    })
    .returning({ id: schema.assignments.id });
  return row!.id;
}

/**
 * Tek senaryo kurar: onExpiry politikası + validUntil ile bir aktif atama → getDeliveries yanıtı.
 * Her senaryo kendi ürün/kalem/sipariş/atamasını alır (izolasyon).
 */
async function deliverScenario(opts: {
  onExpiry: 'hide' | 'keep';
  validUntil: Date | null;
}): Promise<Awaited<ReturnType<OrdersService['getDeliveries']>>> {
  const product = await createProduct(db, { tag, onExpiry: opts.onExpiry });
  const [itemId] = await insertLicenseItems(db, crypto, {
    productId: product.id,
    count: 1,
    tag,
    status: 'assigned',
  });
  const order = await createOrderWithLine(db, { siteId, productId: product.id, qty: 1, tag });
  await insertActiveAssignment({
    orderId: order.orderId,
    lineId: order.lineId,
    licenseItemId: itemId!,
    validUntil: opts.validUntil,
  });
  return svc.getDeliveries({ id: siteId } as unknown as Site, order.orderId);
}

const past = () => new Date(Date.now() - 60_000); // 1 dk önce doldu
const future = () => new Date(Date.now() + 3_600_000); // 1 saat sonra dolacak

describe('OrdersService.getDeliveries — süre-bitişi savunma filtresi', () => {
  beforeAll(async () => {
    const h = makeDb();
    db = h.db;
    end = h.end;
    crypto = makeCrypto();
    // getDeliveries yalnız db + crypto kullanır; kalan bağımlılıklar çağrılmadığı için güvenli stub.
    svc = new OrdersService(
      db as unknown as Database,
      {} as never,
      crypto as never,
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

  it("hide + süresi geçmiş atama (cron gecikmiş) → payload SIZMAZ (deliveries boş)", async () => {
    const res = await deliverScenario({ onExpiry: 'hide', validUntil: past() });
    expect(res.deliveries).toHaveLength(0);
  });

  it('hide + süresi gelecekte → teslim edilir, expired=false, payload dolu', async () => {
    const res = await deliverScenario({ onExpiry: 'hide', validUntil: future() });
    expect(res.deliveries).toHaveLength(1);
    expect(res.deliveries[0]!.expired).toBe(false);
    expect(res.deliveries[0]!.payload).toBeTruthy();
  });

  it('hide + validUntil null (süresiz) → teslim edilir, expired=false', async () => {
    const res = await deliverScenario({ onExpiry: 'hide', validUntil: null });
    expect(res.deliveries).toHaveLength(1);
    expect(res.deliveries[0]!.expired).toBe(false);
    expect(res.deliveries[0]!.validUntil).toBeNull();
  });

  it("keep + süresi geçmiş atama → görünür kalır ama expired=true bayrağı taşır", async () => {
    const res = await deliverScenario({ onExpiry: 'keep', validUntil: past() });
    expect(res.deliveries).toHaveLength(1);
    expect(res.deliveries[0]!.expired).toBe(true);
  });
});
