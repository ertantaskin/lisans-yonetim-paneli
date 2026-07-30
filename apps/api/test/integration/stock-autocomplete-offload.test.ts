import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { StockService } from '../../src/stock/stock.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { ProductsService } from '../../src/products/products.service';
import { AUTOCOMPLETE_JOB } from '../../src/stock/autocomplete.queue';
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
 * ENTEGRASYON — StockService.import BOUNDED-INLINE + ARKA PLAN OFFLOAD (perf).
 *
 * Doğrulanan davranışlar:
 *  (a) küçük backlog (≤CAP) → hepsi INLINE tamamlanır, autoCompleteQueued=false, kuyruğa iş ATILMAZ
 *      (eski hızlı deneyim birebir korunur).
 *  (b) büyük backlog (>CAP) → EN FAZLA CAP satır inline tamamlanır + autoCompleteQueued=true +
 *      kuyruğa {productId} işi jobId=productId ile atılır (kalan backlog arka plana devredilir);
 *      inline değmeyen bekleyen satır hâlâ 'pending' kalır (import isteği asılmaz).
 *  (c) FulfillmentService.autoCompleteProduct maxLines VERİLMEDEN → eski (sınırsız) davranış:
 *      tüm bekleyen satırlar tamamlanır, hasMore=false (geriye dönük uyum).
 *
 * CAP küçük tutulur (config fake AUTOCOMPLETE_INLINE_CAP=2) → 200+ satır seed etmeye gerek yok.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let products: ProductsService;
let fulfillment: FulfillmentService;
let stock: StockService;
let site: CreatedSite;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;

/** Inline cap'i 2'ye sabitleyen config (env AUTOCOMPLETE_INLINE_CAP=2). */
const configCap2 = {
  get: (key: string): string | undefined => (key === 'AUTOCOMPLETE_INLINE_CAP' ? '2' : undefined),
} as never;

/** queue.add çağrılarını KAYDEDEN sahte kuyruk (enqueue doğrulaması için). */
const enqueued: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = [];
const recordingQueue = {
  add: async (name: string, data: unknown, opts: Record<string, unknown>) => {
    enqueued.push({ name, data, opts });
    return { id: (opts?.jobId as string) ?? 'x' };
  },
} as never;

/** Bu ürün için verilen statülerdeki order_line sayısı. */
async function lineCount(productId: string, statuses: string[]): Promise<number> {
  const rows = await db
    .select({ id: schema.orderLines.id, status: schema.orderLines.status })
    .from(schema.orderLines)
    .where(eq(schema.orderLines.productId, productId));
  return rows.filter((r) => statuses.includes(r.status)).length;
}

describe('StockService.import — bounded-inline + arka plan offload', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    products = new ProductsService(db as never);
    fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    stock = new StockService(db as never, crypto, products, fulfillment, configCap2, recordingQueue);
    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('(a) küçük backlog (≤CAP) → hepsi inline, autoCompleteQueued=false, kuyruğa iş ATILMAZ', async () => {
    enqueued.length = 0;
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'partial-auto',
    });
    // Tek bekleyen satır (CAP=2'nin altında).
    await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
      status: 'pending',
    });

    const res = await stock.import(product.id, [{ payload: `A-${tag}-${randomUUID().slice(0, 8)}` }]);
    expect(res.imported).toBe(1);
    expect(res.autoCompleted).toBe(1); // inline tamamlandı
    expect(res.autoCompleteQueued).toBe(false); // kalan yok → kuyruk yok
    expect(enqueued).toHaveLength(0); // queue.add HİÇ çağrılmadı

    // Satır fulfilled oldu.
    expect(await lineCount(product.id, ['fulfilled'])).toBe(1);
  });

  it('(b) büyük backlog (>CAP) → CAP kadar inline + autoCompleteQueued=true + kuyruğa iş atıldı', async () => {
    enqueued.length = 0;
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'partial-auto',
    });
    // 3 bekleyen satır (CAP=2'nin üstünde).
    for (let i = 0; i < 3; i++) {
      await createOrderWithLine(db, {
        siteId: site.id,
        productId: product.id,
        qty: 1,
        tag,
        status: 'pending',
        remoteOrderId: `${tag}-big-${i}-${randomUUID().slice(0, 6)}`,
      });
    }

    // 3 anahtar gir → 3 satırın tamamı doldurulabilir DURUMDA, ama inline yalnız CAP=2 işler.
    const res = await stock.import(product.id, [
      { payload: `B-${tag}-1-${randomUUID().slice(0, 8)}` },
      { payload: `B-${tag}-2-${randomUUID().slice(0, 8)}` },
      { payload: `B-${tag}-3-${randomUUID().slice(0, 8)}` },
    ]);
    expect(res.imported).toBe(3);
    expect(res.autoCompleted).toBe(2); // inline EN FAZLA CAP=2 satır
    expect(res.autoCompleteQueued).toBe(true); // kalan backlog arka plana atıldı

    // Kuyruğa TAM olarak bir iş atıldı: doğru ad + gövde + jobId=productId (dedupe).
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.name).toBe(AUTOCOMPLETE_JOB);
    expect(enqueued[0]!.data).toEqual({ productId: product.id });
    expect(enqueued[0]!.opts.jobId).toBe(product.id);

    // İnline 2 satır fulfilled; 3. satır HÂLÂ pending (arka plan işi çalışmadı — bu test kuyruğu mock'lar).
    expect(await lineCount(product.id, ['fulfilled'])).toBe(2);
    expect(await lineCount(product.id, ['pending', 'partial'])).toBe(1);
  });

  it('(c) autoCompleteProduct maxLines YOK → sınırsız (eski davranış): tümü tamamlanır, hasMore=false', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'partial-auto',
    });
    const lines: string[] = [];
    for (let i = 0; i < 3; i++) {
      const o = await createOrderWithLine(db, {
        siteId: site.id,
        productId: product.id,
        qty: 1,
        tag,
        status: 'pending',
        remoteOrderId: `${tag}-unb-${i}-${randomUUID().slice(0, 6)}`,
      });
      lines.push(o.lineId);
    }
    // Stok doğrudan import edilir ki available olsun (autoComplete tetikleme burada elle).
    await stock.import(product.id, [
      { payload: `C-${tag}-1-${randomUUID().slice(0, 8)}` },
      { payload: `C-${tag}-2-${randomUUID().slice(0, 8)}` },
      { payload: `C-${tag}-3-${randomUUID().slice(0, 8)}` },
    ]);

    // NOT: yukarıdaki import (CAP=2) inline 2 tamamlar + kuyruğa atar (mock → gerçek çalışmaz).
    // Şimdi maxLines VERMEDEN doğrudan çağır → kalan tüm bekleyen satırlar tamamlanmalı.
    const out = await fulfillment.autoCompleteProduct(product.id);
    expect(out.hasMore).toBe(false); // sınırsız → asla cap'e takılmaz

    // Üç satırın tamamı fulfilled (2 inline + kalan bu çağrıda).
    const remaining = await db
      .select({ id: schema.orderLines.id })
      .from(schema.orderLines)
      .where(inArray(schema.orderLines.id, lines));
    expect(remaining).toHaveLength(3);
    expect(await lineCount(product.id, ['fulfilled'])).toBe(3);
    expect(await lineCount(product.id, ['pending', 'partial'])).toBe(0);
  });
});
