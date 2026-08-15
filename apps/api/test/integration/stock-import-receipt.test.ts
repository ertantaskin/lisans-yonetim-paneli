import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTO_RECEIPT_NOTE_PREFIX } from '@lisans/shared';
import * as schema from '../../src/db/schema';
import { ZodBody } from '../../src/common/zod-validation.pipe';
import { StockController } from '../../src/stock/stock.controller';
import { StockService } from '../../src/stock/stock.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { ProductsService } from '../../src/products/products.service';
import { CostsService } from '../../src/reports/costs.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createProduct,
  createSupplier,
  makeCrypto,
  makeDb,
  tagPrefix,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — stok girişiyle AYNI istekte "teslim alınmış" parti + otomatik satın alma
 * emri (§12, `newBatch`). Operatör "12 Ağustos'ta Acme'den aldım, birim 12,34 ₺" der;
 * panel tedarikçiyi çözer, `status='received'` bir PO + partiyi TEK transaction'da açar
 * ve lisans kayıtlarına COGS anlık-görüntüsünü yazar.
 *
 * Doğrulanan invaryantlar (hepsi sessiz PARA hatası üretebilir):
 *  · adet operatörün BEYANINDAN değil GERÇEKTEN girilen kayıttan türer (harcama şişmez),
 *  · `ordered_at` NULL kalır (tedarikçi karnesi avgLeadDays'i "0 gün" ile sıfırlanmaz),
 *  · maliyet raporu bağlantısı: bySupplier harcaması + byMonth teslim-alma ayı kovası
 *    (özelliğin TÜM gerekçesi bu — kova `batches.received_at`ten gelir),
 *  · atomiklik: lisans insert'i patlarsa PO/parti/tedarikçi de geri alınır,
 *  · hepsi mükerrer → ikinci PO AÇILMAZ (çift harcama koruması),
 *  · kuru çalıştırma HİÇBİR şey yazmaz ama gerçek koşunun hatasını (404) ŞİMDİ verir,
 *  · legacy `batchId` yolu (resolveBatchForImport artık tx içinde) bozulmadı.
 *
 * PARA BİRİMLERİ TEST-BENZERSİZ: CostsService global agregasyon yapar (tag ile
 * filtrelenemez) → yalnız bu dosyanın ürettiği satırlar assert edilebilsin diye
 * her senaryo kendi para birimini kullanır.
 */

const tag = randomUUID().slice(0, 8);
const T = tag.slice(0, 4).toUpperCase();
/** Yalnız (1)+(2) mutlu yol + maliyet raporu — byMonth/bySupplier bu kova üzerinden okunur. */
const CUR_MAIN = `RA${T}`;
/** (9) hepsi-mükerrer senaryosu. */
const CUR_DUP = `RB${T}`;
/** (10) tedarikçi yeniden kullanımı. */
const CUR_SUP = `RC${T}`;
/** (13) legacy batchId regresyonu. */
const CUR_LEGACY = `RD${T}`;

/** Teslim alma tarihi: ayın ortası + öğlen UTC → oturum saat dilimi ne olursa olsun '2026-08'. */
const RECEIVED_AT = '2026-08-12T12:00:00.000Z';
const UNIT_COST = 1234;
const ACTOR = 'panel:it-receipt';

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let products: ProductsService;
let stock: StockService;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
// AUTOCOMPLETE_INLINE_CAP tanımsız → varsayılan cap; bu dosyada bekleyen satır yok.
const configFake = { get: () => undefined } as never;
const autocompleteQueueFake = { add: async () => ({ id: 'fake' }) } as never;

/** Benzersiz tedarikçi adı — `cleanupByTag` tedarikçiyi AD üzerinden LIKE ile siler. */
const supplierName = (suffix: string): string => `${tagPrefix(tag)}-sup-${suffix}`;

async function poRows(productId: string) {
  return db
    .select()
    .from(schema.purchaseOrders)
    .where(eq(schema.purchaseOrders.productId, productId));
}

async function batchRows(productId: string) {
  return db.select().from(schema.batches).where(eq(schema.batches.productId, productId));
}

async function itemRows(productId: string) {
  return db
    .select()
    .from(schema.licenseItems)
    .where(eq(schema.licenseItems.productId, productId));
}

/** `it-<tag>-` önekli tedarikçilerden adı (büyük/küçük harf duyarsız) eşleşenler. */
async function supplierCountByName(name: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS c FROM suppliers WHERE lower(name) = lower(${name});
  `)) as unknown as Array<{ c: number }>;
  return Number(rows[0]?.c ?? 0);
}

/** Belirtilen partinin teslim-alma AYı (maliyet raporunun byMonth kovasıyla aynı ifade). */
async function batchMonth(batchId: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT to_char(received_at, 'YYYY-MM') AS month FROM batches WHERE id = ${batchId};
  `)) as unknown as Array<{ month: string }>;
  return rows[0]?.month ?? null;
}

/** Kısayol: N adet benzersiz düz key üretir. */
const keys = (n: number, prefix: string): Array<{ payload: string }> =>
  Array.from({ length: n }, (_, i) => ({ payload: `${prefix}-${tag}-${i}-${randomUUID().slice(0, 8)}` }));

/**
 * `tx.insert(<failTable>)` çağrısını PATLATAN db proxy'si — atomiklik testinde
 * kullanılır. PROD KODA DOKUNULMAZ: yalnız bu dosyada kurulan StockService örneğine
 * verilir; diğer servisler (ProductsService/FulfillmentService) gerçek db ile çalışır.
 */
function makeInsertFailingDb(real: Db, failTable: unknown, message: string): Db {
  type AnyExec = Record<string | symbol, unknown>;
  // Metotlar prototipten gelir → `this` HEDEFE bağlanmalı (proxy'ye değil; drizzle
  // iç durumunu hedef üzerinde tutar).
  const passthrough = (target: AnyExec, prop: string | symbol): unknown => {
    const value = Reflect.get(target, prop);
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(target)
      : value;
  };

  const wrapTx = (tx: AnyExec): AnyExec =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop === 'insert') {
          return (table: unknown) => {
            if (table === failTable) throw new Error(message);
            return (target as unknown as { insert: (t: unknown) => unknown }).insert(table);
          };
        }
        return passthrough(target as AnyExec, prop);
      },
    });

  return new Proxy(real as unknown as AnyExec, {
    get(target, prop) {
      if (prop === 'transaction') {
        return (cb: (tx: unknown) => unknown, ...rest: unknown[]) =>
          (
            target as unknown as { transaction: (c: unknown, ...r: unknown[]) => unknown }
          ).transaction((tx: AnyExec) => cb(wrapTx(tx)), ...rest);
      }
      return passthrough(target as AnyExec, prop);
    },
  }) as unknown as Db;
}

/**
 * Controller'ın GERÇEK gövde doğrulayıcısı (`@Body(new ZodBody(ImportBody))`).
 * `ImportBody` şeması dışa aktarılmadığı için pipe örneği Nest'in route-args
 * metadata'sından alınır → sözleşme katmanı testte KOPYALANMAZ, birebir o çalışır.
 */
function importBodyPipe(): ZodBody<unknown> {
  const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, StockController, 'import') as
    | Record<string, { pipes?: unknown[] }>
    | undefined;
  const pipe = Object.values(meta ?? {})
    .flatMap((arg) => arg.pipes ?? [])
    .find((p): p is ZodBody<unknown> => p instanceof ZodBody);
  if (!pipe) throw new Error('StockController.import gövde pipe’ı bulunamadı (ZodBody).');
  return pipe;
}

/** (1)'in ürettiği veriyi (2) maliyet raporunda okur — "aynı veri" zinciri. */
let receipt: {
  productId: string;
  supplierId: string;
  batchId: string;
} | null = null;

describe('StockService.import + newBatch (otomatik teslim-alma: parti + satın alma emri)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    products = new ProductsService(db as never);
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
    await cleanupByTag(db, tag);
    await end();
  });

  it('(1) mutlu yol: tedarikçi + etiket + tarih + maliyet → received PO (ordered_at NULL) + parti + COGS snapshot', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const label = `${tag}-2026-08 parti #1`;

    const res = await stock.import(product.id, keys(3, 'RCPT'), undefined, false, ACTOR, {
      supplierName: supplierName('acme'),
      label,
      receivedAt: RECEIVED_AT,
      unitCostCents: UNIT_COST,
      currency: CUR_MAIN,
      notes: 'operatör notu',
    });

    expect(res.imported).toBe(3);
    expect(res.rejected).toBe(0);
    expect(res.duplicates).toBe(0);

    const outcome = res.newBatch;
    expect(outcome).toBeDefined();
    expect(outcome!.created).toBe(true);
    expect(outcome!.supplierCreated).toBe(true);
    expect(outcome!.labelDuplicate).toBe(false);
    expect(outcome!.costSnapshotApplied).toBe(true);
    // Adet BEYANDAN değil gerçekten girilen kayıttan türer.
    expect(outcome!.qtyReceived).toBe(3);
    expect(outcome!.currency).toBe(CUR_MAIN);
    // Beyan = giriş olduğu için uyarı ÜRETİLMEZ.
    expect(res.qtyMismatch).toBeUndefined();

    // ── Satın alma emri ──
    const pos = await poRows(product.id);
    expect(pos).toHaveLength(1);
    const po = pos[0]!;
    expect(po.id).toBe(outcome!.purchaseOrderId);
    expect(po.status).toBe('received');
    expect(po.qtyOrdered).toBe(3);
    expect(po.qtyReceived).toBe(3);
    expect(po.unitCostCents).toBe(UNIT_COST);
    expect(po.currency).toBe(CUR_MAIN);
    // KRİTİK: ordered_at NULL — aksi halde tedarikçi karnesi her stok girişine
    // "0 gün tedarik süresi" ekleyip KPI'ı sıfıra çekerdi.
    expect(po.orderedAt).toBeNull();
    expect(po.receivedAt?.toISOString()).toBe(RECEIVED_AT);
    expect(po.notes?.startsWith(AUTO_RECEIPT_NOTE_PREFIX)).toBe(true);
    expect(po.notes).toContain('operatör notu');

    // ── Parti ──
    const batches = await batchRows(product.id);
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch.id).toBe(outcome!.batchId);
    expect(batch.purchaseOrderId).toBe(po.id);
    expect(batch.supplierId).toBe(po.supplierId);
    expect(batch.label).toBe(label);
    expect(batch.qtyReceived).toBe(3);
    expect(batch.receivedAt.toISOString()).toBe(RECEIVED_AT);
    // Maliyet raporunun ay kovası bu ifadeden gelir.
    expect(await batchMonth(batch.id)).toBe('2026-08');

    // ── Lisans kayıtları: parti bağı + COGS anlık-görüntüsü ──
    const items = await itemRows(product.id);
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.batchId).toBe(batch.id);
      expect(item.unitCostCents).toBe(UNIT_COST);
      expect(item.costCurrency).toBe(CUR_MAIN);
    }

    receipt = { productId: product.id, supplierId: po.supplierId, batchId: batch.id };
  });

  it('(2) maliyet raporu bağlantısı: bySupplier harcaması + byMonth 2026-08 kovası', async () => {
    // (1) ile AYNI veri — özelliğin gerekçesi tam olarak bu rapor satırlarının oluşmasıdır.
    expect(receipt).not.toBeNull();
    /*
     * `allTime` BİLEREK: rapor artık parametresiz çağrıldığında son 12 ayı gösterir (denetim
     * bulgusu O7). Bu testin `RECEIVED_AT`'i SABİT bir tarihtir — pencereye bağlı kalsaydı
     * takvim ilerledikçe (o tarih 12 ayı geçince) test kendiliğinden kırılırdı. Ölçülen şey
     * "stok girişi doğru rapor satırlarını üretiyor mu", pencere davranışı değil.
     */
    const report = await new CostsService(db as never).getCostReport({ allTime: true });

    const supplierRow = report.bySupplier.find(
      (r) => r.supplierId === receipt!.supplierId && r.currency === CUR_MAIN,
    );
    expect(supplierRow).toBeDefined();
    expect(supplierRow!.spentCents).toBe(3 * UNIT_COST);
    expect(supplierRow!.poCount).toBe(1);

    // byMonth kovası PO oluşturma anına DEĞİL parti teslim-alma tarihine göredir.
    const monthRows = report.byMonth.filter((r) => r.currency === CUR_MAIN);
    expect(monthRows).toHaveLength(1);
    expect(monthRows[0]!.month).toBe('2026-08');
    expect(monthRows[0]!.spentCents).toBe(3 * UNIT_COST);
  });

  it('(3) batchId + newBatch birlikte → sözleşme (ZodBody) ve servis AYRI AYRI reddeder', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const orphanBatchId = randomUUID();
    const pipe = importBodyPipe();

    // Pozitif kontrol: pipe gerçekten ImportBody'dir (geçerli gövde sorunsuz geçer).
    expect(() =>
      pipe.transform({ productId: product.id, items: [{ payload: 'OK' }] }),
    ).not.toThrow();

    // Sözleşme katmanı.
    let thrown: unknown;
    try {
      pipe.transform({
        productId: product.id,
        items: [{ payload: 'X' }],
        batchId: orphanBatchId,
        newBatch: { label: 'çakışma' },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    const issues = (thrown as BadRequestException).getResponse() as {
      issues: Array<{ path: string; message: string }>;
    };
    expect(issues.issues.some((i) => i.path === 'newBatch')).toBe(true);

    // Servis katmanı (iç çağıranlar controller'ı atlayabilir → savunma guard'ı).
    await expect(
      stock.import(
        product.id,
        [{ payload: `X-${tag}-${randomUUID().slice(0, 8)}` }],
        orphanBatchId,
        false,
        ACTOR,
        { label: 'çakışma' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(await itemRows(product.id)).toHaveLength(0);
  });

  it('(4) atomiklik: lisans insert’i patlarsa PO + parti + tedarikçi TAMAMEN geri alınır', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const name = supplierName(`rollback-${randomUUID().slice(0, 6)}`);
    const failMsg = 'SİMÜLE EDİLMİŞ license_items insert hatası';

    // Yalnız BU servis örneği sabote edilmiş db görür (prod kod değişmez).
    const brokenStock = new StockService(
      makeInsertFailingDb(db, schema.licenseItems, failMsg) as never,
      crypto,
      products,
      new FulfillmentService(db as never, products, mailFake, webhookFake),
      configFake,
      autocompleteQueueFake,
    );

    await expect(
      brokenStock.import(product.id, keys(2, 'ROLL'), undefined, false, ACTOR, {
        supplierName: name,
        label: `${tag}-rollback`,
        unitCostCents: 999,
        currency: CUR_MAIN,
      }),
    ).rejects.toThrow(failMsg);

    expect(await poRows(product.id)).toHaveLength(0);
    expect(await batchRows(product.id)).toHaveLength(0);
    expect(await itemRows(product.id)).toHaveLength(0);
    // Tedarikçi de AYNI transaction'da açılıyordu → o da geri alınmalı.
    expect(await supplierCountByName(name)).toBe(0);
  });

  it('(5) dryRun + newBatch → hiçbir satır yazılmaz; echo çözülür; UYDURMA supplierId 404 verir', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const name = supplierName(`dry-${randomUUID().slice(0, 6)}`);
    const label = `  ${tag}-kuru parti  `;

    const res = await stock.import(product.id, keys(2, 'DRY'), undefined, true, ACTOR, {
      supplierName: name,
      label,
      receivedAt: RECEIVED_AT,
      unitCostCents: 555,
      currency: 'usd',
    });

    expect(res.dryRun).toBe(true);
    expect(res.imported).toBe(0);
    expect(res.wouldImport).toBe(2);

    const outcome = res.newBatch;
    expect(outcome).toBeDefined();
    expect(outcome!.created).toBe(false);
    expect(outcome!.reason).toBe('dry_run');
    // Echo alanları GERÇEK koşudaki gibi çözülmüş olmalı (kırpılmış etiket, ISO tarih,
    // büyük harfe normalize para birimi, tahmini adet).
    expect(outcome!.label).toBe(label.trim());
    expect(outcome!.receivedAt).toBe(RECEIVED_AT);
    expect(outcome!.currency).toBe('USD');
    expect(outcome!.qtyReceived).toBe(2);
    expect(outcome!.supplierName).toBe(name);
    expect(outcome!.supplierCreated).toBe(true); // TAHMİN: "bu adla açılacak"
    expect(outcome!.supplierExisting).toBe(false);
    expect(outcome!.costSnapshotApplied).toBe(true);

    // Kuru çalıştırma HİÇBİR şey yazmaz (tedarikçi dâhil).
    expect(await poRows(product.id)).toHaveLength(0);
    expect(await batchRows(product.id)).toHaveLength(0);
    expect(await itemRows(product.id)).toHaveLength(0);
    expect(await supplierCountByName(name)).toBe(0);

    // Kuru koşu "temiz" deyip gerçek koşunun patlamasına izin VERMEZ: var olmayan
    // tedarikçi ŞİMDİ 404 olur (gerçek koşuyla birebir aynı hata).
    await expect(
      stock.import(product.id, keys(1, 'DRY404'), undefined, true, ACTOR, {
        supplierId: randomUUID(),
        label: `${tag}-yok`,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('(6) tedarikçisiz + maliyetli → 400 ve HİÇBİR lisans girmez (guard insert’ten ÖNCE)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });

    await expect(
      stock.import(product.id, keys(3, 'NOSUP'), undefined, false, ACTOR, {
        label: `${tag}-maliyet-tedarikçisiz`,
        unitCostCents: 100,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(await itemRows(product.id)).toHaveLength(0);
    expect(await batchRows(product.id)).toHaveLength(0);
    expect(await poRows(product.id)).toHaveLength(0);
  });

  it('(7) tedarikçisiz + maliyetsiz → yalnız bağımsız parti (PO YOK, snapshot NULL)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });

    const res = await stock.import(product.id, keys(2, 'FREE'), undefined, false, ACTOR, {
      label: `${tag}-elle parti`,
    });

    const outcome = res.newBatch;
    expect(outcome!.created).toBe(true);
    expect(outcome!.purchaseOrderId).toBeNull();
    expect(outcome!.supplierId).toBeNull();
    expect(outcome!.currency).toBeNull();
    expect(outcome!.costSnapshotApplied).toBe(false);

    // Satın alma emri AÇILMAZ (tedarikçisiz emir tedarik raporlarını kirletirdi).
    expect(await poRows(product.id)).toHaveLength(0);

    const batches = await batchRows(product.id);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.supplierId).toBeNull();
    expect(batches[0]!.purchaseOrderId).toBeNull();

    const items = await itemRows(product.id);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.batchId).toBe(batches[0]!.id);
      expect(item.unitCostCents).toBeNull();
      expect(item.costCurrency).toBeNull();
    }
  });

  it('(8) hepsi reddedildi (keyFormat uyumsuz) → parti/PO OLUŞMAZ, reason=all_rejected', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    await db
      .update(schema.products)
      .set({ keyFormat: '^KEY-\\d+$' })
      .where(eq(schema.products.id, product.id));

    const res = await stock.import(
      product.id,
      [{ payload: 'gecersiz-1' }, { payload: 'gecersiz-2' }],
      undefined,
      false,
      ACTOR,
      { supplierName: supplierName('red'), label: `${tag}-boş parti`, currency: CUR_MAIN },
    );

    expect(res.requested).toBe(2);
    expect(res.imported).toBe(0);
    expect(res.rejected).toBe(2);
    expect(res.newBatch!.created).toBe(false);
    expect(res.newBatch!.reason).toBe('all_rejected');
    expect(res.newBatch!.qtyReceived).toBe(0);

    // Boş parti + 0 adetli hayalet emir tedarik raporlarını kirletirdi → hiçbiri yazılmaz.
    expect(await poRows(product.id)).toHaveLength(0);
    expect(await batchRows(product.id)).toHaveLength(0);
    expect(await itemRows(product.id)).toHaveLength(0);
  });

  it('(9) hepsi mükerrer → ConflictException; İKİNCİ satın alma emri AÇILMAZ (çift harcama yok)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const items = keys(2, 'DUP');

    const first = await stock.import(product.id, items, undefined, false, ACTOR, {
      supplierName: supplierName('dup'),
      label: `${tag}-dup-1`,
      unitCostCents: 700,
      currency: CUR_DUP,
    });
    expect(first.imported).toBe(2);
    expect(await poRows(product.id)).toHaveLength(1);

    // Aynı anahtarlar yeniden yapıştırıldı: tek TAZE kayıt bile yok → tam rollback.
    await expect(
      stock.import(product.id, items, undefined, false, ACTOR, {
        supplierName: supplierName('dup'),
        label: `${tag}-dup-2`,
        unitCostCents: 700,
        currency: CUR_DUP,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(await poRows(product.id)).toHaveLength(1);
    expect(await batchRows(product.id)).toHaveLength(1);
    expect(await itemRows(product.id)).toHaveLength(2);
  });

  it('(10) aynı tedarikçi adı FARKLI KASA ile → mükerrer tedarikçi açılmaz (yeniden kullanılır)', async () => {
    const productA = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const productB = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const base = `reuse-${randomUUID().slice(0, 6)}`;
    const lower = supplierName(base);
    // Yalnız SON ek büyük harfe çevrilir: `it-<tag>-` öneki korunur (cleanup LIKE'ı
    // büyük/küçük harf duyarlıdır — önek bozulursa satır yetim kalır).
    const upper = supplierName(base.toUpperCase());

    const first = await stock.import(productA.id, keys(1, 'SUP1'), undefined, false, ACTOR, {
      supplierName: lower,
      label: `${tag}-sup-1`,
      currency: CUR_SUP,
    });
    expect(first.newBatch!.supplierCreated).toBe(true);

    const second = await stock.import(productB.id, keys(1, 'SUP2'), undefined, false, ACTOR, {
      supplierName: upper,
      label: `${tag}-sup-2`,
      currency: CUR_SUP,
    });
    expect(second.newBatch!.supplierCreated).toBe(false);
    expect(second.newBatch!.supplierExisting).toBe(true);
    expect(second.newBatch!.supplierId).toBe(first.newBatch!.supplierId);

    // 'Acme' her girişte bir daha birikmez (suppliers.name UNIQUE DEĞİL).
    expect(await supplierCountByName(lower)).toBe(1);
  });

  it('(11) receivedAt sınırları: şimdi+7 gün → 400; şimdi−3 yıl → kabul', async () => {
    const future = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const past = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const plus7 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const minus3y = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000).toISOString();

    // İleri tarih maliyet raporunda KALICI "hayalet ay" satırı bırakırdı.
    await expect(
      stock.import(future.id, keys(1, 'FUT'), undefined, false, ACTOR, {
        label: `${tag}-gelecek`,
        receivedAt: plus7,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await batchRows(future.id)).toHaveLength(0);
    expect(await itemRows(future.id)).toHaveLength(0);

    const res = await stock.import(past.id, keys(1, 'PAST'), undefined, false, ACTOR, {
      label: `${tag}-geçmiş`,
      receivedAt: minus3y,
    });
    expect(res.newBatch!.created).toBe(true);
    const batches = await batchRows(past.id);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.receivedAt.toISOString()).toBe(minus3y);
  });

  it('(12) aynı ürün + aynı etiket → labelDuplicate uyarısı, ama giriş ENGELLENMEZ', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const label = `${tag}-aynı etiket`;

    const first = await stock.import(product.id, keys(1, 'LBL1'), undefined, false, ACTOR, {
      label,
    });
    expect(first.newBatch!.created).toBe(true);
    expect(first.newBatch!.labelDuplicate).toBe(false);

    const second = await stock.import(product.id, keys(1, 'LBL2'), undefined, false, ACTOR, {
      label,
    });
    // Uyarı EVET, 409 HAYIR — operatör aynı etiketi bilerek tekrar kullanabilir.
    expect(second.newBatch!.created).toBe(true);
    expect(second.newBatch!.labelDuplicate).toBe(true);

    expect(await batchRows(product.id)).toHaveLength(2);
    expect(await itemRows(product.id)).toHaveLength(2);
  });

  it('(13) legacy regresyon: elle kurulan maliyetli PO + parti, batchId ile import → snapshot kopyalanır', async () => {
    // resolveBatchForImport transaction'ın İÇİNE taşındı; eski `batchId` yolunun
    // COGS anlık-görüntüsü davranışı bozulmamalı.
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const supplier = await createSupplier(db, { tag });

    const [po] = await db
      .insert(schema.purchaseOrders)
      .values({
        supplierId: supplier.id,
        productId: product.id,
        status: 'received',
        qtyOrdered: 5,
        qtyReceived: 5,
        unitCostCents: 4321,
        currency: CUR_LEGACY,
        receivedAt: new Date(RECEIVED_AT),
      })
      .returning({ id: schema.purchaseOrders.id });

    const [batch] = await db
      .insert(schema.batches)
      .values({
        supplierId: supplier.id,
        purchaseOrderId: po!.id,
        productId: product.id,
        label: `${tag}-legacy`,
        qtyReceived: 5,
        receivedAt: new Date(RECEIVED_AT),
      })
      .returning({ id: schema.batches.id });

    const res = await stock.import(product.id, keys(2, 'LEG'), batch!.id, false, ACTOR);
    expect(res.imported).toBe(2);
    // `newBatch` gönderilmeyen klasik import → alan HİÇ dönmez (sözleşme değişmedi).
    expect(res.newBatch).toBeUndefined();

    const items = await itemRows(product.id);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.batchId).toBe(batch!.id);
      expect(item.unitCostCents).toBe(4321);
      expect(item.costCurrency).toBe(CUR_LEGACY);
    }
  });
});
