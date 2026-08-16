import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema';
import { StockService } from '../../src/stock/stock.service';
import { ProductsService } from '../../src/products/products.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { CryptoService } from '../../src/crypto/crypto.service';
import { cleanupByTag, createProduct, makeCrypto, makeDb, type Db } from './_helpers';

/**
 * ENTEGRASYON — çok kullanımlı (MAK) kalemin KAPASİTE düzeltmesi (`adjustMultiUseCapacity`).
 *
 * NEDEN BU UÇ VAR (kullanıcı ihtiyacı): "MAK ürünlerde kapasiteyi tekrar düzenleyemiyorum…
 * 1000 kullanım hakkı vardı, 900 kalmış, bunu manuel tekrar 1000'e çıkartabilsem." Ürün
 * formundaki `maxUses` YALNIZ yeni girilen kalemlere uygulanır; mevcut satırın tavanını
 * değiştiren bir yol yoktu ve kapasitesi tükenmiş anahtar geri döndürülemiyordu.
 *
 * KİLİTLENEN SÖZLEŞMELER (hepsi bir hata sınıfını kapatır):
 *   · `use_count` ASLA değişmez — teslim edilmiş aktivasyonları temsil eder; düşürmek
 *     aynı hakları ikinci kez satılabilir gösterir (§2) ve `reconcile` (a) invaryantını
 *     (`use_count ≤ max_uses`) kırar. Değişen TEK şey `max_uses`.
 *   · `depleted` kalem kapasite alınca `available` olur — aksi halde kapasite artar ama
 *     kalem hiçbir atama sorgusuna girmez (SESSİZ no-op; kullanıcının ekran görüntüsündeki
 *     "5/5 · Tükendi" vakası tam olarak budur).
 *   · tek kullanımlık (single) üründe REDDEDİLİR — orada kapasite kavramı yoktur.
 *   · terminal durumdaki kalem (voided/quarantined/…) REDDEDİLİR — kapasite vermek onu
 *     satılabilir yapmaz, sessiz no-op yerine açık hata.
 *   · sebep ZORUNLU + denetim izi (`audit_log.meta.op='capacity_bump'`) eski/yeni tavanı taşır.
 *
 * NOT: bu paket gerçek PostgreSQL ister (VPS izole test DB'si). Yazıldığı makinede
 * çalıştırılamadı; `pnpm --filter @lisans/api test:integration` ile koşulmalıdır.
 */

const tag = randomUUID().slice(0, 8);
const ACTOR = 'panel:it-capacity';

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let stock: StockService;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const configFake = { get: () => undefined } as never;
const autocompleteQueueFake = { add: async () => ({ id: 'fake' }) } as never;

/** MAK kalemi doğrudan yazar (atama motoru bu testin konusu değil). */
async function insertMultiItem(
  productId: string,
  opts: { maxUses: number; useCount: number; status?: 'available' | 'depleted' | 'voided' },
): Promise<string> {
  const id = randomUUID();
  const plaintext = `CAP-${tag}-${randomUUID().slice(0, 8)}`;
  await db.insert(schema.licenseItems).values({
    id,
    productId,
    payloadEnc: crypto.encrypt(plaintext, CryptoService.licenseItemAad(id)),
    payloadHash: crypto.payloadHash(plaintext),
    payloadSuffixHash: crypto.payloadSuffixHash(plaintext),
    maxUses: opts.maxUses,
    useCount: opts.useCount,
    status: opts.status ?? 'available',
  });
  return id;
}

async function readItem(id: string) {
  const [row] = await db.select().from(schema.licenseItems).where(eq(schema.licenseItems.id, id));
  return row!;
}

/** Bu kalem için yazılan kapasite düzeltmesi denetim kaydı (varsa). */
async function readCapacityAudit(id: string) {
  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.targetId, id), eq(schema.auditLog.actor, ACTOR)));
  return rows.filter(
    (r) => (r.meta as { op?: string } | null)?.op === 'capacity_bump',
  );
}

/**
 * Kapasite artışından SONRA tamamlama motorunun tetiklendiğini kanıtlamak için çağrı defteri.
 *
 * NEDEN TEST EDİLİYOR: kapasite artışı GERÇEK satılabilir birim yaratır (tükenmiş anahtar
 * `available`'a döner). Tetiklenmezse bekleyen siparişler stok VARKEN, bir sonraki stok
 * girişine ya da elle "Kalanları Ata"ya kadar SESSİZCE bekler — bu projede tekrarlayan
 * "yeni stok göründü ama süpürme koşmadı" sınıfının aynısı (bkz. eşlenmemiş satır partisi).
 */
const autoCalls: string[] = [];

describe('MAK kalem kapasite düzeltmesi', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    const products = new ProductsService(db as never);
    const fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    // GERÇEK metot korunur (sonuç gerçekten koşar), yalnız çağrı kaydedilir.
    const realAuto = fulfillment.autoCompleteProduct.bind(fulfillment);
    fulfillment.autoCompleteProduct = (async (pid: string, cap?: number) => {
      autoCalls.push(pid);
      return realAuto(pid, cap);
    }) as typeof fulfillment.autoCompleteProduct;
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
    await db.execute(sql`DELETE FROM audit_log WHERE actor = ${ACTOR}`);
    await cleanupByTag(db, tag);
    await end();
  });

  it('(a) kalan hak yükseltilir; use_count DEĞİŞMEZ, tavan use_count + kalan olur', async () => {
    const product = await createProduct(db, { tag, usageMode: 'multi', maxUses: 1000 });
    // Kullanıcının anlattığı vaka: 1000 haklı anahtarın 100'ü satılmış, 900 kalmış.
    const id = await insertMultiItem(product.id, { maxUses: 1000, useCount: 100 });

    const res = await stock.adjustMultiUseCapacity(
      id,
      { remainingUses: 1000, reason: 'Tedarikçi 100 ek aktivasyon tanımladı' },
      ACTOR,
    );

    expect(res.maxUses).toBe(1100);
    expect(res.useCount).toBe(100);
    expect(res.remainingUses).toBe(1000);
    expect(res.previousMaxUses).toBe(1000);

    const row = await readItem(id);
    // §2 İNVARYANTI: teslim edilmiş aktivasyon sayısı korunur (düşürmek sessiz aşırı-satış olurdu).
    expect(row.useCount).toBe(100);
    expect(row.maxUses).toBe(1100);
    expect(row.status).toBe('available');

    const audit = await readCapacityAudit(id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.meta).toMatchObject({
      op: 'capacity_bump',
      oldMaxUses: 1000,
      newMaxUses: 1100,
      useCount: 100,
      reason: 'Tedarikçi 100 ek aktivasyon tanımladı',
    });
  });

  it('(b) TÜKENMİŞ (depleted) kalem kapasite alınca yeniden STOKTA olur', async () => {
    const product = await createProduct(db, { tag, usageMode: 'multi', maxUses: 5 });
    // Ekran görüntüsündeki vaka: 5/5, "Tükendi".
    const id = await insertMultiItem(product.id, { maxUses: 5, useCount: 5, status: 'depleted' });

    const res = await stock.adjustMultiUseCapacity(
      id,
      { remainingUses: 5, reason: 'Tedarikçi kapasiteyi yeniledi' },
      ACTOR,
    );

    expect(res.maxUses).toBe(10);
    // KRİTİK: durum canlanmazsa kapasite artar ama kalem hiçbir atamaya GİRMEZ (sessiz no-op).
    expect(res.status).toBe('available');
    expect((await readItem(id)).status).toBe('available');

    // Taze satılabilir birim göründü → tamamlama motoru KOŞMALI (stok girişiyle aynı yol).
    expect(autoCalls).toContain(product.id);
  });

  it('(c) kapasite DÜŞÜRÜLEBİLİR; tam use_count seviyesine inince kalem "depleted" olur', async () => {
    const product = await createProduct(db, { tag, usageMode: 'multi', maxUses: 100 });
    const id = await insertMultiItem(product.id, { maxUses: 100, useCount: 40 });

    const res = await stock.adjustMultiUseCapacity(
      id,
      { remainingUses: 0, reason: 'Tedarikçi kalan hakları geri aldı' },
      ACTOR,
    );

    expect(res.maxUses).toBe(40);
    expect(res.useCount).toBe(40);
    expect(res.remainingUses).toBe(0);
    expect(res.status).toBe('depleted');

    // DÜŞÜRMEDE yeni satılabilir birim YOK → gereksiz süpürme koşmamalı (asimetri bilinçli).
    expect(autoCalls).not.toContain(product.id);
  });

  it('(d) TEK KULLANIMLIK üründe reddedilir — orada kapasite kavramı yok', async () => {
    const product = await createProduct(db, { tag, usageMode: 'single' });
    const id = await insertMultiItem(product.id, { maxUses: 1, useCount: 0 });

    await expect(
      stock.adjustMultiUseCapacity(id, { remainingUses: 5, reason: 'deneme' }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect((await readItem(id)).maxUses).toBe(1);
  });

  it('(e) terminal durumdaki kalem reddedilir — kapasite onu satılabilir yapmaz', async () => {
    const product = await createProduct(db, { tag, usageMode: 'multi', maxUses: 10 });
    const id = await insertMultiItem(product.id, {
      maxUses: 10,
      useCount: 2,
      status: 'voided',
    });

    await expect(
      stock.adjustMultiUseCapacity(id, { remainingUses: 10, reason: 'deneme' }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);

    const row = await readItem(id);
    expect(row.maxUses).toBe(10);
    expect(row.status).toBe('voided');
  });

  it('(f) sebep zorunlu — denetim izi gerekçesiz kalmaz', async () => {
    const product = await createProduct(db, { tag, usageMode: 'multi', maxUses: 10 });
    const id = await insertMultiItem(product.id, { maxUses: 10, useCount: 1 });

    await expect(
      stock.adjustMultiUseCapacity(id, { remainingUses: 20, reason: '  ' }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect((await readItem(id)).maxUses).toBe(10);
  });

  it('(g) negatif/kesirli kalan ve tavan aşımı reddedilir; değişiklik yoksa da yazılmaz', async () => {
    const product = await createProduct(db, { tag, usageMode: 'multi', maxUses: 10 });
    const id = await insertMultiItem(product.id, { maxUses: 10, useCount: 3 });

    await expect(
      stock.adjustMultiUseCapacity(id, { remainingUses: -1, reason: 'deneme' }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      stock.adjustMultiUseCapacity(id, { remainingUses: 1.5, reason: 'deneme' }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Ürün formundakiyle AYNI tavan (MAX_USES_CAP = 100.000): tek satırla stok sayaçlarını
    // anlamsızlaştırmak mümkün olmamalı.
    await expect(
      stock.adjustMultiUseCapacity(id, { remainingUses: 100_000, reason: 'deneme' }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Mevcut değerin aynısı → gereksiz denetim kaydı yazmak yerine açık hata.
    await expect(
      stock.adjustMultiUseCapacity(id, { remainingUses: 7, reason: 'deneme' }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect((await readItem(id)).maxUses).toBe(10);
    expect(await readCapacityAudit(id)).toHaveLength(0);
  });

  it('(h) olmayan kalem 404', async () => {
    await expect(
      stock.adjustMultiUseCapacity(randomUUID(), { remainingUses: 5, reason: 'deneme' }, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
