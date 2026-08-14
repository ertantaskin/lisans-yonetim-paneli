import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { MailService } from '../../src/mail/mail.service';
import { ProductsService } from '../../src/products/products.service';
import { SuppliersService } from '../../src/procurement/suppliers.service';
import { WebhookService } from '../../src/webhook/webhook.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createProduct,
  createSite,
  createSupplier,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  tagPrefix,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — LİSTE KIRPILMASI GÖRÜNÜR OLMALI + karantina önizleme kapısı (denetim L2-1/PERF-1/PERF-2).
 *
 * Bu projenin tekrar eden hata sınıfı SESSİZ KIRPMA'dır: liste bir üst sınıra dayanır, operatör
 * "hepsi bu kadarmış" sanar ve pencereden düşen kayıtlar kalıcı olarak işlenmeden kalır. Üç yüzey
 * kilitlenir:
 *   · İnceleme kuyruğu (§8 held_for_review) — düşenler EN ESKİ held siparişlerdir (müşteri ödedi,
 *     lisans teslim edilmedi) → `{ items, truncated, limit }`.
 *   · Tedarikçi karnesi parti listesi — her stok girişi bir parti üretir, liste sınırsız büyüyordu
 *     → `batchesTruncated` + sayaç GERÇEK `count(*)`tan (`batchCount`), liste uzunluğundan DEĞİL.
 *   · Karantina önizlemesi (`preview=false`) — satır başına AES-GCM çözmeyi tamamen kapatır;
 *     satır SAYISI ve SIRASI değişmemelidir (perf düzeltmesi davranışı bozmasın).
 *
 * NOT: bu dosya gerçek Postgres ister (DATABASE_URL) — Windows geliştirme makinesinde KOŞULMADI,
 * yalnız typecheck ile derlendiği doğrulandı.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let admin: AdminOrdersService;
let suppliersSvc: SuppliersService;

/** Karantina reveal audit'i bu aktörle yazılır → afterAll'da tek sorguyla temizlenir. */
const ACTOR = `panel:trunc-${tag}`;

/**
 * `count` adet HELD sipariş ekler (createOrder yolunu tetiklemeden — kuyruk listesinin tek
 * koşulu `held_for_review = true`). heldAt açıkça set edilir: sıralama (`heldAt DESC, id DESC`)
 * bu kolondan gelir ve NULL bırakılırsa satırlar DESC'te (NULLS FIRST) pencerenin başına
 * toplanıp testi anlamsızlaştırırdı.
 */
async function seedHeldOrders(siteId: string, count: number): Promise<string[]> {
  const now = Date.now();
  const rows = Array.from({ length: count }, (_, i) => {
    const rid = `${tagPrefix(tag)}-held-${randomUUID().slice(0, 8)}`;
    return {
      siteId,
      remoteOrderId: rid,
      customerEmail: `${tag}@example.test`,
      status: 'pending' as const,
      heldForReview: true,
      // Farklı damgalar: en yeni önce sıralamasının gerçekten çalıştığı gözlenebilsin.
      heldAt: new Date(now - i * 1000),
      heldReason: 'it-truncation',
      idempotencyKey: `${siteId}:${rid}`,
    };
  });
  const inserted = await db
    .insert(schema.orders)
    .values(rows)
    .returning({ id: schema.orders.id });
  return inserted.map((r) => r.id);
}

/** `count` adet parti ekler (tedarikçi + ürün bağlı; PO yok — elle giriş yolu). */
async function seedBatches(supplierId: string, productId: string, count: number): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) => ({
    supplierId,
    productId,
    label: `${tagPrefix(tag)}-batch-${String(i).padStart(4, '0')}`,
    qtyReceived: 1,
  }));
  await db.insert(schema.batches).values(rows);
}

describe('liste kırpılması görünür + karantina önizleme kapısı', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();

    // Nest DI olmadan hafif sahteler — bu dosyanın kapsamı okuma yollarının DÖNÜŞ SÖZLEŞMESİ;
    // mail/webhook/redis yan etkileri değil (quarantine-mask.test.ts deseni).
    const fakeQueue = { add: async () => undefined } as unknown as Queue;
    const fakeRedis = {} as unknown as Redis;
    const fakeConfig = { get: () => undefined, getOrThrow: () => '' } as never;
    const products = new ProductsService(db as never);
    const mail = new MailService(db as never, fakeQueue, fakeConfig);
    const webhook = new WebhookService(db as never, fakeQueue);
    const fulfillment = new FulfillmentService(db as never, products, mail, webhook);
    admin = new AdminOrdersService(db as never, fakeRedis, crypto, mail, fulfillment);
    suppliersSvc = new SuppliersService(db as never);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM audit_log WHERE actor = ${ACTOR}`);
    await cleanupByTag(db, tag);
    await end();
  });

  // ── (a) İnceleme kuyruğu (L2-1) ──────────────────────────────────────────────────────
  //
  // SIRA ÖNEMLİ: "tavan altı" senaryosu, tavanı AŞAN senaryodan ÖNCE koşmalıdır — listHeldOrders
  // GLOBAL'dir (site süzgeci yok), yani aynı dosyada 201 held sipariş seed edildikten sonra
  // "tavan altı" iddiası bir daha kurulamaz. Vitest bir dosyadaki testleri tanım sırasına göre
  // seri koşar; dosyalar arası paralellik de kapalı (fileParallelism: false).
  it('tavanın ALTINDA: truncated=false ve seed edilen held siparişler listede', async () => {
    const site = await createSite(db, crypto, { tag });
    const ids = await seedHeldOrders(site.id, 3);

    const queue = await admin.listHeldOrders();

    // Sözleşme: düz dizi DEĞİL.
    expect(Array.isArray(queue.items)).toBe(true);
    expect(queue.limit).toBe(200);
    // Ön koşul: bu test DB'sinde tavanı dolduracak kadar held sipariş yok (aksi halde aşağıdaki
    // truncated=false iddiası zaten anlamsız olurdu → sessizce yanlış geçmesin diye açıkça yazılır).
    expect(queue.items.length).toBeLessThan(queue.limit);
    expect(queue.truncated).toBe(false);

    const found = queue.items.filter((o) => ids.includes(o.id));
    expect(found).toHaveLength(3);
    expect(found[0]!.siteDomain).toBe(site.domain);
  });

  it('tavanı AŞINCA: truncated=true ve items.length === limit (fazladan satır SIZMAZ)', async () => {
    const site = await createSite(db, crypto, { tag });
    // Tek başına tavanı (200) aşacak kadar → kuyruk toplamı ne olursa olsun kırpma KESİN.
    await seedHeldOrders(site.id, 201);

    const queue = await admin.listHeldOrders();

    expect(queue.truncated).toBe(true);
    // TAVAN+1 çekilip JS'te kırpıldığı için yanıt tam TAVAN kadar satır taşır (tespit satırı sızmaz).
    expect(queue.items).toHaveLength(queue.limit);
    // Sıralama korunur: en yeni held üstte (heldAt DESC).
    const stamps = queue.items.map((o) => (o.heldAt ? new Date(o.heldAt).getTime() : 0));
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
  });

  // ── (b) Karantina önizleme kapısı (PERF-1) ───────────────────────────────────────────
  it('listQuarantine(preview:false) keyPreview üretmez ama satır sayısı/sırası AYNI kalır', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const itemIds = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 5,
      tag,
      payloadPrefix: 'TRUNC',
    });
    // Ölü/geçersiz anahtar → karantina listesine girer.
    for (const id of itemIds) {
      await db
        .update(schema.licenseItems)
        .set({ status: 'quarantined' })
        .where(eq(schema.licenseItems.id, id));
    }

    const withPreview = await admin.listQuarantine({ productId: product.id, actor: ACTOR });
    const noPreview = await admin.listQuarantine({
      productId: product.id,
      actor: ACTOR,
      preview: false,
    });

    // Satır SAYISI ve SIRASI birebir aynı — perf kapısı sonucu değiştirmez.
    expect(withPreview.rows).toHaveLength(5);
    expect(noPreview.rows.map((r) => r.licenseItemId)).toEqual(
      withPreview.rows.map((r) => r.licenseItemId),
    );
    expect(noPreview.truncated).toBe(withPreview.truncated);

    // preview AÇIK (varsayılan): düz metin üretildi (payload çözüldü).
    expect(withPreview.rows.every((r) => typeof r.keyPreview === 'string')).toBe(true);
    expect(withPreview.rows[0]!.keyPreview).toContain(tag);
    // preview KAPALI: alan var ama null — hiçbir satırda çözme koşmadı.
    expect(noPreview.rows.every((r) => r.keyPreview === null)).toBe(true);

    // Diğer alanlar (perf kapısının dışındakiler) aynen döner.
    expect(noPreview.rows[0]!.productId).toBe(product.id);
    expect(noPreview.rows[0]!.status).toBe('quarantined');

    // Denetim izi DÜRÜST: çözme koşmadıysa "görüntülendi" kaydı YAZILMAZ → tek çağrı kadar
    // (preview'li) reveal kaydı olmalı, iki değil.
    const [audit] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actor, ACTOR),
          eq(schema.auditLog.action, 'reveal'),
          eq(schema.auditLog.targetType, 'quarantine'),
        ),
      );
    expect(Number(audit!.c)).toBe(1);
  });

  // ── (c) Tedarikçi karnesi parti listesi (PERF-2) ─────────────────────────────────────
  it('karne parti listesi tavanla kırpılır; batchesTruncated + batchCount GERÇEK sayımdan', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });

    // Tavanın ALTINDA tedarikçi: kırpma yok, sayaç = liste uzunluğu.
    const small = await createSupplier(db, { tag, name: 'small' });
    await seedBatches(small.id, product.id, 3);
    const smallCard = await suppliersSvc.scorecard(small.id);
    expect(smallCard.batches).toHaveLength(3);
    expect(smallCard.batchesTruncated).toBe(false);
    expect(smallCard.batchCount).toBe(3);

    // Tavanı AŞAN tedarikçi (200 + 1).
    const big = await createSupplier(db, { tag, name: 'big' });
    await seedBatches(big.id, product.id, 201);
    const bigCard = await suppliersSvc.scorecard(big.id);
    expect(bigCard.batches).toHaveLength(200);
    expect(bigCard.batchesTruncated).toBe(true);
    // Sayaç liste uzunluğundan TÜRETİLMEZ — kırpılmış listede 200 derdi.
    expect(bigCard.batchCount).toBe(201);
    // Kırpma iki tedarikçiyi karıştırmaz (supplier_id süzgeci LIMIT'ten önce uygulanır).
    expect(bigCard.batches.every((b) => b.label.startsWith(`${tagPrefix(tag)}-batch-`))).toBe(true);
  });
});
