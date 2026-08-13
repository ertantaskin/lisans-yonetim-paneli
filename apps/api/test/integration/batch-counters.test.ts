import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { SupplyOpsService } from '../../src/supply-ops/supply-ops.service';
import * as schema from '../../src/db/schema';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createOrderWithLine,
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
 * ENTEGRASYON — parti sayaçları (`listBatches` / `getBatch`).
 *
 * NEDEN BU DOSYA VAR: kullanıcı `/batches` ekranında "Satılmış 6 birim müşterilerde —
 * bunlar için değişim gerekir" uyarısını gördü ama müşteride 6 anahtar YOKTU; bir kısmı
 * ELLE geçersiz kılınmıştı. Kök neden: sayaç `status <> 'available'` yüklemiydi, yani
 * "available olmayan HER ŞEY" (voided / quarantined / replaced / revoked / expired) tek
 * kovaya düşüyordu. Aynı ekrandaki `recallBatch` ise çoktan doğru yüklemi (`EXISTS aktif
 * atama`) kullanıyordu → iki tanım yan yana çelişiyordu ve `canBulkReplace` bu yanlış
 * sayaca bağlı olduğu için değiştirilecek hiçbir şey yokken "Toplu Değiştir" sunuluyordu.
 *
 * Bu sayaçların HİÇ testi yoktu — hatanın yaşamasının sebebi tam olarak budur. Aşağıdakiler
 * kovaların ATAMADAN türediğini kalıcı olarak kilitler.
 */

const tag = randomUUID().slice(0, 8);
const ACTOR = 'panel:it-batch-counters';

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let supplyOps: SupplyOpsService;

/** Testin ürünü + tedarikçisi için bir parti (satın alma emri gerektirmeden). */
async function createBatch(productId: string, label: string): Promise<string> {
  const supplier = await createSupplier(db, { tag });
  const [row] = await db
    .insert(schema.batches)
    .values({
      productId,
      supplierId: supplier.id,
      label: `${tagPrefix(tag)}-${label}`,
      qtyReceived: 0,
      receivedAt: new Date(),
    })
    .returning({ id: schema.batches.id });
  return row!.id;
}

async function attach(batchId: string, licenseItemIds: string[]): Promise<void> {
  await db
    .update(schema.licenseItems)
    .set({ batchId })
    .where(inArray(schema.licenseItems.id, licenseItemIds));
}

describe('parti sayaçları — kovalar DURUMDAN değil ATAMADAN türer', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    // Bu testler yalnız listBatches/getBatch okur → diğer bağımlılıklar kullanılmaz.
    supplyOps = new SupplyOpsService(db as never, null as never, null as never);
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('ELLE geçersiz kılınan anahtar "müşterilerde" SAYILMAZ — bildirilen hatanın kendisi', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const ids = await insertLicenseItems(db, crypto, { productId: product.id, count: 5, tag });
    const batchId = await createBatch(product.id, 'elle-void');
    await attach(batchId, ids);

    // 2 kalem operatör tarafından geçersiz kılınıyor (toplu düşme yolunun sonucu).
    await db
      .update(schema.licenseItems)
      .set({ status: 'voided' })
      .where(inArray(schema.licenseItems.id, ids.slice(0, 2)));

    const b = await supplyOps.getBatch(batchId);

    expect(b.totalCount).toBe(5);
    expect(b.unsoldCount).toBe(3); // geri çekmenin void edeceği küme — DEĞİŞMEDİ
    // ESKİ DAVRANIŞ 2 derdi ("Satılmış 2 birim müşterilerde, değişim gerekir").
    expect(b.customerCount).toBe(0);
    expect(b.replaceableCount).toBe(0);
    expect(b.deadCount).toBe(2);
  });

  it('CANLI ataması olan anahtar müşterilerde sayılır; iade edilmiş (karantina) olan sayılmaz', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const site = await createSite(db, crypto, { tag });
    const ids = await insertLicenseItems(db, crypto, { productId: product.id, count: 4, tag });
    const batchId = await createBatch(product.id, 'canli-atama');
    await attach(batchId, ids);

    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 3,
      tag,
    });

    // ids[0] → aktif atama (değiştirilebilir)
    // ids[1] → askıda atama (müşterinin elinde ama OTOMATİK değiştirilmez)
    // ids[2] → iade/değişimde geri alınmış: karantina + 'replaced' atama (ölü)
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
    await mk(ids[2]!, 'quarantined', 'replaced');

    const b = await supplyOps.getBatch(batchId);

    expect(b.totalCount).toBe(4);
    expect(b.unsoldCount).toBe(1); // yalnız ids[3]
    // Askıdaki atama da CANLIDIR (H1 dersi: "askıda" ölü değildir, geri açılabilir).
    expect(b.customerCount).toBe(2);
    // Otomatik toplu değiştirme YALNIZ aktif atamayı hedefler → askıdaki hariç.
    expect(b.replaceableCount).toBe(1);
    // Karantinaya alınmış (değiştirilmiş) kalem ölüdür.
    expect(b.deadCount).toBe(1);
  });

  it('MAK/çok kullanımlı anahtar hem stokta hem müşterilerde sayılabilir (kovalar TOPLANMAZ)', async () => {
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'multi',
      maxUses: 500,
    });
    const site = await createSite(db, crypto, { tag });
    const ids = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      maxUses: 500,
    });
    const batchId = await createBatch(product.id, 'mak');
    await attach(batchId, ids);

    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 3,
      tag,
    });
    // 500 hakkın 3'ü satıldı → kalem HÂLÂ 'available' (kapasite var) ama müşteride de var.
    await db
      .update(schema.licenseItems)
      .set({ useCount: 3 })
      .where(eq(schema.licenseItems.id, ids[0]!));
    await db.insert(schema.assignments).values({
      orderId: order.orderId,
      lineId: order.lineId,
      licenseItemId: ids[0]!,
      units: 3,
      status: 'active',
    });

    const b = await supplyOps.getBatch(batchId);

    expect(b.totalCount).toBe(1);
    expect(b.unsoldCount).toBe(1);
    expect(b.customerCount).toBe(1);
    // Ekranlar "toplam = stokta + müşteride + düşmüş" ARİTMETİĞİ KURMAMALI — bu satır sebebi.
    expect(b.unsoldCount + b.customerCount + b.deadCount).toBeGreaterThan(b.totalCount);
  });

  it('tek parti sorgusu (getBatch) alt sorguyu da o partiye daraltır — başka partiler sızmaz', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const aIds = await insertLicenseItems(db, crypto, { productId: product.id, count: 2, tag });
    const bIds = await insertLicenseItems(db, crypto, { productId: product.id, count: 3, tag });
    const batchA = await createBatch(product.id, 'izole-a');
    const batchB = await createBatch(product.id, 'izole-b');
    await attach(batchA, aIds);
    await attach(batchB, bIds);

    expect((await supplyOps.getBatch(batchA)).totalCount).toBe(2);
    expect((await supplyOps.getBatch(batchB)).totalCount).toBe(3);

    // Ve alt sorgunun `onlyId` süzgeci gerçekten uygulanıyor mu (plan değil, sonuç kontrolü):
    // aynı ürünün partisiz kalemleri hiçbir partinin sayacına girmemeli.
    await insertLicenseItems(db, crypto, { productId: product.id, count: 4, tag });
    expect((await supplyOps.getBatch(batchA)).totalCount).toBe(2);
    const orphan = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(schema.licenseItems)
      .where(sql`${schema.licenseItems.productId} = ${product.id} AND ${schema.licenseItems.batchId} IS NULL`);
    expect(Number(orphan[0]!.c)).toBe(4);
  });
});
