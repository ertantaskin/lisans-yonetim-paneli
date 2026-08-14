import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { SuppliersService } from '../../src/procurement/suppliers.service';
import { StockService } from '../../src/stock/stock.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { ProductsService } from '../../src/products/products.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createProduct,
  createSupplier,
  makeCrypto,
  makeDb,
  type CreatedProduct,
  type CreatedSupplier,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — tedarik zinciri YAZMA yolu: `PurchaseOrdersService.receive()` (§12).
 *
 * NEDEN VAR: denetimde bu yol TESTSİZ işaretlendi. Teslim alma bir DEFTER yazma yoludur —
 * `qty_received` artışı, durum geçişi (`ordered → partial → received`), parti (batch) açılışı
 * ve maliyet zinciri tek transaction'da olur. Buradaki her sessiz kayma doğrudan PARAYA
 * dokunur: fazladan teslim alınmış gösterilen adet, tedarikçiye ödenmemiş/çift ödenmiş
 * harcama ya da hiç var olmayan bir partiye yazılan lisans anlamına gelir.
 *
 * `cleanupByTag` TEDARİK ZİNCİRİNİ KAPSIYOR (kod okundu: stock_adjustments → batches →
 * purchase_orders → suppliers → products); tedarikçi AD önekinden, PO/parti ise tag'li
 * ÜRÜNden bulunur. Bu dosyanın tüm PO/partileri tag'li ürüne bağlı → elle temizlik gerekmez.
 * (audit_log append-only ve FK taşımaz; diğer entegrasyon testlerindeki gibi bırakılır.)
 */

const tag = randomUUID().slice(0, 8);
const T = tag.slice(0, 4).toUpperCase();
/** Para birimi ayrımı testinde kullanılan iki BENZERSİZ kod (karışım assert'i için). */
const CUR_A = `PA${T}`;
const CUR_B = `PB${T}`;
/** COGS zinciri (parti → lisans kalemi anlık görüntüsü). */
const CUR_COGS = `PC${T}`;
/** int4 taşma regresyonu. */
const CUR_BIG = `PD${T}`;

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let po: PurchaseOrdersService;
let suppliersSvc: SuppliersService;
let stock: StockService;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const configFake = { get: () => undefined } as never;
const autocompleteQueueFake = { add: async () => ({ id: 'fake' }) } as never;

/** Tag'li ürün + tedarikçi + PO üçlüsü — her senaryo kendi izole zincirini kurar. */
async function seedPo(opts: {
  qtyOrdered: number;
  unitCostCents?: number;
  currency?: string;
  status?: 'draft' | 'ordered';
  supplier?: CreatedSupplier;
  product?: CreatedProduct;
}): Promise<{ poId: string; product: CreatedProduct; supplier: CreatedSupplier }> {
  const product = opts.product ?? (await createProduct(db, { tag, kind: 'key', usageMode: 'single' }));
  const supplier = opts.supplier ?? (await createSupplier(db, { tag }));
  const row = await po.create({
    supplierId: supplier.id,
    productId: product.id,
    status: opts.status ?? 'ordered',
    qtyOrdered: opts.qtyOrdered,
    unitCostCents: opts.unitCostCents,
    currency: opts.currency,
  });
  return { poId: row.id, product, supplier };
}

/** Bir PO'ya açılmış partiler (teslim alma yan etkisinin TEK gözlemlenebilir izi). */
async function batchesOf(poId: string) {
  return db.select().from(schema.batches).where(eq(schema.batches.purchaseOrderId, poId));
}

/** Bir PO'nun teslim-alma denetim kayıtları. */
async function receiveAudits(poId: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.targetId, poId), eq(schema.auditLog.targetType, 'purchase_order')));
}

async function reload(poId: string) {
  const [row] = await db
    .select()
    .from(schema.purchaseOrders)
    .where(eq(schema.purchaseOrders.id, poId))
    .limit(1);
  return row!;
}

/** N adet benzersiz düz key (stok import'u için). */
const keys = (n: number, prefix: string): Array<{ payload: string }> =>
  Array.from({ length: n }, (_, i) => ({
    payload: `${prefix}-${tag}-${i}-${randomUUID().slice(0, 8)}`,
  }));

describe('PurchaseOrdersService.receive (kısmi teslim-al + over-receive kilidi, §12)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    po = new PurchaseOrdersService(db as never);
    suppliersSvc = new SuppliersService(db as never);
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
    await cleanupByTag(db, tag);
    await end();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Mutlu yol: kısmi → tam teslim alma
  // ─────────────────────────────────────────────────────────────────────────

  it('(1) kısmi teslim-al: 10 sipariş / 4 al → qtyReceived=4, status=partial, parti 4 adet', async () => {
    // REGRESYON: kısmi teslimat birinci sınıf akış. Durumun erkenden 'received'a
    // atlaması ya da partiye SİPARİŞ adedinin (4 yerine 10) yazılması, hiç gelmemiş
    // anahtarları "elimde" gösterir ve tedarikçi harcamasını şişirir.
    const { poId, product, supplier } = await seedPo({ qtyOrdered: 10 });

    const res = await po.receive(poId, { qty: 4, batchLabel: `${tag}-parti-1`, notes: 'ilk sevkiyat' });

    expect(res.accepted).toBe(4);
    expect(res.purchaseOrder.qtyReceived).toBe(4);
    expect(res.purchaseOrder.status).toBe('partial');
    expect(res.purchaseOrder.qtyOrdered).toBe(10);

    const batches = await batchesOf(poId);
    expect(batches).toHaveLength(1);
    // Partiye KABUL EDİLEN adet yazılır (sipariş adedi değil) — stok/maliyet bunu okur.
    expect(batches[0]!.qtyReceived).toBe(4);
    expect(batches[0]!.label).toBe(`${tag}-parti-1`);
    expect(batches[0]!.notes).toBe('ilk sevkiyat');
    expect(batches[0]!.status).toBe('active');
    // Parti tedarikçi/ürün bağını PO'dan devralır (recall + karne zinciri buna bağlı).
    expect(batches[0]!.supplierId).toBe(supplier.id);
    expect(batches[0]!.productId).toBe(product.id);
    expect(res.batchId).toBe(batches[0]!.id);

    // Denetim izi: her teslim alma TEK kayıt bırakır.
    const audits = await receiveAudits(poId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('receive');
    expect(audits[0]!.meta).toMatchObject({ accepted: 4, qtyReceived: 4, status: 'partial' });
  });

  it('(2) kalanı al: aynı emirden 6 daha → status=received, toplam 10, İKİNCİ parti açılır', async () => {
    // REGRESYON: ikinci teslim alma qtyReceived'i EKLEMELİ (üzerine yazmamalı) ve
    // AYRI bir parti açmalı — partiler farklı tarih/kalitede gelir, tek partiye
    // toplanırsa geri çekme (recall) yanlış anahtar kümesini süpürür.
    const { poId } = await seedPo({ qtyOrdered: 10 });
    await po.receive(poId, { qty: 4, batchLabel: `${tag}-p1` });

    const res = await po.receive(poId, { qty: 6, batchLabel: `${tag}-p2` });

    expect(res.accepted).toBe(6);
    expect(res.purchaseOrder.qtyReceived).toBe(10);
    expect(res.purchaseOrder.status).toBe('received');

    const batches = await batchesOf(poId);
    expect(batches).toHaveLength(2);
    expect(batches.reduce((sum, b) => sum + b.qtyReceived, 0)).toBe(10);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Over-receive kilidi
  // ─────────────────────────────────────────────────────────────────────────

  it('(3) over-receive REDDEDİLİR: kalan 0 iken tekrar al → 400 ve HİÇBİR yan etki yok', async () => {
    // REGRESYON (asıl kilit): tamamen teslim alınmış emre yapılan çağrı sessizce
    // accepted=0 dönmemeli VE hayalet/sıfır adetli parti açmamalıdır. Sıfır adetli
    // bir parti stok import'unda seçilebilir hale gelir ve maliyet raporunda
    // karşılığı olmayan bir kova üretir.
    const { poId } = await seedPo({ qtyOrdered: 3 });
    await po.receive(poId, { qty: 3, batchLabel: `${tag}-tam` });

    const before = await reload(poId);
    expect(before.status).toBe('received');

    await expect(po.receive(poId, { qty: 1, batchLabel: `${tag}-fazla` })).rejects.toThrow(
      BadRequestException,
    );

    // Yan etki YOK: adet, durum, parti sayısı ve denetim kaydı sayısı DEĞİŞMEDİ.
    const after = await reload(poId);
    expect(after.qtyReceived).toBe(3);
    expect(after.status).toBe('received');
    expect(await batchesOf(poId)).toHaveLength(1);
    expect(await receiveAudits(poId)).toHaveLength(1);
  });

  it('(4) aşırı adet KIRPILIR: kalan 5 iken 99 al → accepted=5, parti 5 (99 değil)', async () => {
    // REGRESYON: kabul = min(qty, kalan). Kırpma kalkarsa qty_received sipariş adedini
    // AŞAR; tedarikçi karnesi "sipariş edilenden fazla teslim alındı" gibi imkânsız bir
    // tablo üretir ve partiye var olmayan 99 adet yazılır.
    const { poId } = await seedPo({ qtyOrdered: 5 });

    const res = await po.receive(poId, { qty: 99, batchLabel: `${tag}-kirp` });

    expect(res.accepted).toBe(5);
    expect(res.purchaseOrder.qtyReceived).toBe(5);
    expect(res.purchaseOrder.status).toBe('received');
    const batches = await batchesOf(poId);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.qtyReceived).toBe(5);
  });

  it('(5) eşzamanlı iki teslim-al (7+7 / sipariş 10): toplam alınan sipariş adedini AŞMAZ', async () => {
    // REGRESYON — TOCTOU: `remaining` hesabı satır kilidinin (FOR UPDATE) ALTINDA
    // yapılmazsa iki eşzamanlı istek de aynı bayat qty_received'i okur ve toplam
    // 14 olur (sipariş 10). Kilit doğruysa ikinci istek TAZE değeri görüp 3'e kırpar.
    const { poId } = await seedPo({ qtyOrdered: 10 });

    const results = await Promise.all([
      po.receive(poId, { qty: 7, batchLabel: `${tag}-e1` }),
      po.receive(poId, { qty: 7, batchLabel: `${tag}-e2` }),
    ]);

    const totalAccepted = results.reduce((sum, r) => sum + r.accepted, 0);
    expect(totalAccepted).toBe(10);
    // Sıra deterministik değil; kümenin kendisi sabittir.
    expect(results.map((r) => r.accepted).sort((a, b) => a - b)).toEqual([3, 7]);

    const after = await reload(poId);
    expect(after.qtyReceived).toBe(10);
    expect(after.status).toBe('received');

    const batches = await batchesOf(poId);
    expect(batches).toHaveLength(2);
    // Partilerin toplamı = defterdeki adet (parti ile PO defteri asla ayrışmamalı).
    expect(batches.reduce((sum, b) => sum + b.qtyReceived, 0)).toBe(10);
  });

  it('(6) eşzamanlı iki teslim-al (1+1 / sipariş 1): biri geçer, diğeri REDDEDİLİR', async () => {
    // REGRESYON: kilit yoksa iki istek de "kalan 1" görür ve İKİSİ de parti açar
    // (1 sipariş → 2 parti = bedava stok). Kilit doğruysa ikinci istek kalanı 0
    // bulur ve 400 alır; parti sayısı 1'de kalır.
    const { poId } = await seedPo({ qtyOrdered: 1 });

    const settled = await Promise.allSettled([
      po.receive(poId, { qty: 1, batchLabel: `${tag}-tek-a` }),
      po.receive(poId, { qty: 1, batchLabel: `${tag}-tek-b` }),
    ]);

    const ok = settled.filter((s) => s.status === 'fulfilled');
    const failed = settled.filter((s) => s.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);

    const after = await reload(poId);
    expect(after.qtyReceived).toBe(1);
    expect(await batchesOf(poId)).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Girdi/durum guard'ları
  // ─────────────────────────────────────────────────────────────────────────

  it('(7) geçersiz adet (0 / negatif / ondalık / NaN) reddedilir — parti AÇILMAZ', async () => {
    // REGRESYON: `qty <= 0` kontrolü TEK BAŞINA yetmez — NaN ile her karşılaştırma
    // false döner, guard'ı geçer ve `Math.min(NaN, kalan)` NaN'ı integer defterine
    // taşır. Ondalık adet ise PG tarafında yuvarlanarak kalandan fazlasını teslim
    // alınmış gösterebilir. (Controller şeması da aynı kuralı uygular; bu assert
    // servisin DOĞRUDAN çağrıldığı yolları kilitler.)
    const { poId } = await seedPo({ qtyOrdered: 5 });

    for (const qty of [0, -1, 1.5, Number.NaN]) {
      await expect(po.receive(poId, { qty, batchLabel: `${tag}-gecersiz` })).rejects.toThrow(
        BadRequestException,
      );
    }

    const after = await reload(poId);
    expect(after.qtyReceived).toBe(0);
    expect(after.status).toBe('ordered');
    expect(await batchesOf(poId)).toHaveLength(0);
  });

  it('(8) iptal edilmiş emre teslim alınamaz; olmayan emir 404', async () => {
    // REGRESYON: iptal edilmiş emre parti açmak, iptal kararını sessizce geri alır.
    const { poId } = await seedPo({ qtyOrdered: 5 });
    await po.update(poId, { status: 'cancelled' });

    await expect(po.receive(poId, { qty: 1, batchLabel: `${tag}-iptal` })).rejects.toThrow(
      BadRequestException,
    );
    expect(await batchesOf(poId)).toHaveLength(0);

    await expect(
      po.receive(randomUUID(), { qty: 1, batchLabel: `${tag}-yok` }),
    ).rejects.toThrow(NotFoundException);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Maliyet zinciri
  // ─────────────────────────────────────────────────────────────────────────

  it('(9) COGS zinciri: receive ile açılan partiye stok girilince kalemler PO maliyetini alır', async () => {
    // REGRESYON: maliyet PARTİDE durmaz (batches'ta maliyet kolonu YOKTUR) — lisans
    // kalemine PO'dan anlık görüntü olarak kopyalanır. Bu bağ koparsa teslim edilen
    // maliyet (deliveredCogs) sessizce "kapsanamayan" olur; rapor eksik ama HATASIZ
    // görünür. Zincirin `receive()` ile açılan parti ayağı testsizdi.
    const { poId, product } = await seedPo({
      qtyOrdered: 10,
      unitCostCents: 1234,
      currency: CUR_COGS,
    });
    const res = await po.receive(poId, { qty: 3, batchLabel: `${tag}-cogs` });

    const imported = await stock.import(product.id, keys(3, 'COGS'), res.batchId, false, 'panel:it-po');
    expect(imported.imported).toBe(3);

    const items = await db
      .select()
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.productId, product.id));
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.batchId).toBe(res.batchId);
      expect(item.unitCostCents).toBe(1234);
      // Para birimi kalemde AYRI tutulur (raporda başka bir para birimiyle toplanmaz).
      expect(item.costCurrency).toBe(CUR_COGS);
    }
  });

  it('(10) tedarikçi karnesi: iki para birimli alımda KARIŞIM yok, adetler doğru', async () => {
    // REGRESYON (bu projede daha önce yaşandı): farklı para birimlerindeki tutarlar
    // tek toplama birleştirilirse rakam anlamsız olur (5 USD + 5 TRY = 10 ???).
    // Karne satırları para birimi BAŞINA ayrı olmalı.
    const supplier = await createSupplier(db, { tag });
    const a = await seedPo({ qtyOrdered: 10, unitCostCents: 100, currency: CUR_A, supplier });
    const b = await seedPo({ qtyOrdered: 4, unitCostCents: 250, currency: CUR_B, supplier });

    await po.receive(a.poId, { qty: 6, batchLabel: `${tag}-kur-a` }); // 6 × 100 = 600
    await po.receive(b.poId, { qty: 4, batchLabel: `${tag}-kur-b` }); // 4 × 250 = 1000

    const card = await suppliersSvc.scorecard(supplier.id);

    expect(card.poCount).toBe(2);
    expect(card.totalOrdered).toBe(14);
    expect(card.totalReceived).toBe(10);
    // a hâlâ kısmi (6/10) → açık; b tamamen teslim alındı → açık DEĞİL.
    expect(card.openPoCount).toBe(1);

    const rowA = card.totalCostCents.find((r) => r.currency === CUR_A);
    const rowB = card.totalCostCents.find((r) => r.currency === CUR_B);
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
    expect(rowA!.cents).toBe(600);
    expect(rowB!.cents).toBe(1000);
    // Tek bir "toplam" satırına ÇÖKMEZ: bu tedarikçide tam iki para birimi vardır.
    expect(card.totalCostCents).toHaveLength(2);

    // Partiler karnede görünür (teslim alma → parti bağı).
    expect(card.batches).toHaveLength(2);
    expect(card.batches.reduce((sum, x) => sum + x.qtyReceived, 0)).toBe(10);
    expect(card.recallRate).toBe(0);
  });

  it('(11) yüksek birim maliyet int4 TAŞMASINA yol açmaz (karne 500 vermez)', async () => {
    // REGRESYON (bu turda bulundu): karne maliyeti `sum(qty_received * unit_cost_cents)`
    // ile hesaplanıyordu. PG'de `int4 * int4` yine int4'tür ve TOPLAMA GİRMEDEN taşar
    // (SQLSTATE 22003 → ekran ham 500); sondaki `::bigint` cast'i çok geç kalıyordu.
    // Denetim sınırları bu değerlere izin veriyor (unitCostCents ≤ 2e9, qty ≤ 1e6).
    const supplier = await createSupplier(db, { tag });
    const { poId } = await seedPo({
      qtyOrdered: 2,
      unitCostCents: 2_000_000_000,
      currency: CUR_BIG,
      supplier,
    });
    await po.receive(poId, { qty: 2, batchLabel: `${tag}-buyuk` });

    const card = await suppliersSvc.scorecard(supplier.id);
    const row = card.totalCostCents.find((r) => r.currency === CUR_BIG);
    expect(row).toBeDefined();
    // 2 × 2.000.000.000 = 4.000.000.000 > 2^31-1 → int4'te taşardı.
    expect(row!.cents).toBe(4_000_000_000);
  });

  it('(12) received_at YALNIZ emir tamamlanınca yazılır (kısmi teslimde BOŞ kalır)', async () => {
    // REGRESYON: alan her kısmi teslim almada üzerine yazılıyordu → anlamı "SON sevkiyat"
    // oluyordu ve status=partial iken de doluyordu. Tek tüketicisi tedarikçi karnesindeki
    // avgLeadDays; açık emirler ortalamaya girip tedarik süresini olduğundan KISA gösteriyordu.
    const { poId } = await seedPo({ qtyOrdered: 6 });

    await po.receive(poId, { qty: 2, batchLabel: tag + '-ra-1' });
    const afterPartial = await reload(poId);
    expect(afterPartial.status).toBe('partial');
    expect(afterPartial.receivedAt).toBeNull();

    await po.receive(poId, { qty: 4, batchLabel: tag + '-ra-2' });
    const afterFull = await reload(poId);
    expect(afterFull.status).toBe('received');
    expect(afterFull.receivedAt).not.toBeNull();

    // Sevkiyat başına tarih KAYBOLMAZ: her teslim alma kendi partisini damgalar.
    const b = await batchesOf(poId);
    expect(b).toHaveLength(2);
    expect(b.every((x) => x.receivedAt != null)).toBe(true);
  });

  it('(13) denetim izine GERÇEK admin yazılır (sabit panel:admin değil)', async () => {
    // REGRESYON: servis audit_log.actor alanına sabit 'panel:admin' yazıyordu, yani
    // "teslim alan kim" sorusunun cevabı hiç kaydedilmiyordu (jsdoc aksini söylüyordu).
    const { poId } = await seedPo({ qtyOrdered: 3 });
    await po.receive(poId, { qty: 3, batchLabel: tag + '-actor' }, 'panel:ertan@ornek');
    const audits = await receiveAudits(poId);
    expect(audits.some((a) => a.actor === 'panel:ertan@ornek')).toBe(true);
  });
});
