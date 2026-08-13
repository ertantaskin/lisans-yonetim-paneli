import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema';
import { SupplierClaimsService } from '../../src/supplier-claims/supplier-claims.service';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createProduct,
  createSupplier,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  tagPrefix,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — tedarikçi değişim fişleri (§12).
 *
 * NEDEN BU DOSYA VAR: panelde "bu kusurlu anahtarı tedarikçiye bildirdim mi?" bilgisi HİÇ
 * tutulmuyordu; tek bildirim yolu izi olmayan bir tarayıcı indirmesiydi. Aşağıdakiler yeni
 * sürecin DEĞİŞMEZLERİNİ kilitler — özellikle "aynı anahtar iki fişe giremez" ve "reddedilen
 * anahtar havuza geri döner" (kullanıcının açık kararı).
 */

const tag = randomUUID().slice(0, 8);
const ACTOR = 'panel:it-claims';

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let claims: SupplierClaimsService;

/** Karantina havuzunda görünen kusurlu kalemler üretir (parti + tedarikçi zinciriyle). */
async function seedDefects(opts: {
  count: number;
  label: string;
  /** Kalemleri bu kadar gün önce ölmüş gibi göster (stok düzeltme damgası). */
  daysAgo?: number;
}): Promise<{ productId: string; supplierId: string; batchId: string; itemIds: string[] }> {
  const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
  const supplier = await createSupplier(db, { tag });
  const [batch] = await db
    .insert(schema.batches)
    .values({
      productId: product.id,
      supplierId: supplier.id,
      label: `${tagPrefix(tag)}-${opts.label}`,
      qtyReceived: opts.count,
      receivedAt: new Date(),
    })
    .returning({ id: schema.batches.id });

  const itemIds = await insertLicenseItems(db, crypto, {
    productId: product.id,
    count: opts.count,
    tag,
    payloadPrefix: `DEF-${opts.label}`,
  });
  await db
    .update(schema.licenseItems)
    .set({ batchId: batch!.id, status: 'voided' })
    .where(inArray(schema.licenseItems.id, itemIds));

  // Sebep + tarih `stock_adjustments`'tan okunur (voided kalemlerde atama/geçmiş yoktur).
  const at = new Date(Date.now() - (opts.daysAgo ?? 0) * 86_400_000);
  await db.insert(schema.stockAdjustments).values(
    itemIds.map((id) => ({
      productId: product.id,
      licenseItemId: id,
      action: 'damage' as const,
      qty: 1,
      reason: `tedarikçi kusuru (${opts.label})`,
      actor: ACTOR,
      createdAt: at,
    })),
  );
  // license_items.created_at da pencereye girsin (tarih ön-filtresi baseAt'e bakıyor).
  await db
    .update(schema.licenseItems)
    .set({ createdAt: at })
    .where(inArray(schema.licenseItems.id, itemIds));

  return { productId: product.id, supplierId: supplier.id, batchId: batch!.id, itemIds };
}

/** Havuzda (bildirilmemiş) kaç kusurlu kalem var? */
async function poolCount(supplierId: string): Promise<number> {
  const res = await claims.candidates({ supplierId, reveal: true, actor: ACTOR });
  return res.rows.length;
}

describe('tedarikçi değişim fişleri', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    // (db, redis, crypto, mail, fulfillment) — bu testler YALNIZ listQuarantine okur;
    // redis/mail/fulfillment o yolda kullanılmaz.
    const adminOrders = new AdminOrdersService(
      db as never,
      null as never,
      crypto,
      null as never,
      null as never,
    );
    claims = new SupplierClaimsService(db as never, adminOrders);
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('fiş kesilince kalemler havuzdan DÜŞER ve snapshot yazılır', async () => {
    const { supplierId, itemIds } = await seedDefects({ count: 4, label: 'p1' });
    expect(await poolCount(supplierId)).toBe(4);

    const created = await claims.create({ supplierId }, ACTOR, true);
    expect(created.itemCount).toBe(4);
    expect(created.code).toMatch(/^DEG-\d{8}-\d{2}$/);

    // Havuz boşaldı — aynı kalemler bir daha aday olarak gelmez.
    expect(await poolCount(supplierId)).toBe(0);

    const { claim, items } = await claims.detail(created.id);
    expect(claim.status).toBe('draft');
    expect(claim.itemCount).toBe(4);
    expect(items).toHaveLength(4);
    expect(new Set(items.map((i) => i.licenseItemId))).toEqual(new Set(itemIds));
    // SNAPSHOT: parti etiketi + sebep + kusur kaynağı fiş anında donmuş olmalı.
    for (const i of items) {
      expect(i.batchLabel).toContain('p1');
      expect(i.reason).toContain('tedarikçi kusuru');
      expect(i.defectKind).toBe('damage');
      expect(i.keySnapshot).toBeTruthy();
      expect(i.outcome).toBe('pending');
    }
  });

  it('AYNI kalem ikinci bir fişe GİREMEZ (kısmi unique index)', async () => {
    const { supplierId } = await seedDefects({ count: 2, label: 'p2' });
    await claims.create({ supplierId }, ACTOR, true);
    // Havuz boş → ikinci fiş kesilemez (400).
    await expect(claims.create({ supplierId }, ACTOR, true)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('REDDEDİLEN kalem havuza GERİ DÖNER ve yeniden fişlenebilir', async () => {
    const { supplierId } = await seedDefects({ count: 3, label: 'p3' });
    const c1 = await claims.create({ supplierId }, ACTOR, true);
    await claims.updateStatus(c1.id, { status: 'sent' }, ACTOR);

    const { items } = await claims.detail(c1.id);
    const rejected = items.slice(0, 2).map((i) => i.id);
    await claims.updateItems(c1.id, { itemIds: rejected, outcome: 'rejected' }, ACTOR);

    // 2 kalem havuza döndü → yeniden aday.
    expect(await poolCount(supplierId)).toBe(2);

    // Ve GERÇEKTEN yeni bir fişe girebiliyor (index engellemiyor).
    const c2 = await claims.create({ supplierId }, ACTOR, true);
    expect(c2.itemCount).toBe(2);

    // Yenilenen kalem havuza DÖNMEZ.
    const { items: items2 } = await claims.detail(c2.id);
    await claims.updateStatus(c2.id, { status: 'sent' }, ACTOR);
    await claims.updateItems(c2.id, { itemIds: [items2[0]!.id], outcome: 'replaced' }, ACTOR);
    expect(await poolCount(supplierId)).toBe(0);
  });

  it('TASLAK fiş iptal edilince kalemler serbest kalır; GÖNDERİLMİŞ fiş iptal EDİLEMEZ', async () => {
    const { supplierId } = await seedDefects({ count: 2, label: 'p4' });
    const c = await claims.create({ supplierId }, ACTOR, true);
    expect(await poolCount(supplierId)).toBe(0);

    await claims.updateStatus(c.id, { status: 'canceled' }, ACTOR);
    // Kalemler SİLİNDİ → havuza döndü (fiş yanlış kesilmişti).
    expect(await poolCount(supplierId)).toBe(2);
    const after = await claims.detail(c.id);
    expect(after.items).toHaveLength(0);
    expect(after.claim.itemCount).toBe(0);

    // Gönderilmiş fiş iptal edilemez.
    const c2 = await claims.create({ supplierId }, ACTOR, true);
    await claims.updateStatus(c2.id, { status: 'sent' }, ACTOR);
    await expect(
      claims.updateStatus(c2.id, { status: 'canceled' }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('TASLAK fişte sonuç işaretlenemez (önce gönderildi denmeli)', async () => {
    const { supplierId } = await seedDefects({ count: 1, label: 'p5' });
    const c = await claims.create({ supplierId }, ACTOR, true);
    const { items } = await claims.detail(c.id);
    await expect(
      claims.updateItems(c.id, { itemIds: [items[0]!.id], outcome: 'replaced' }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('Z raporu YALNIZ tarih penceresindeki kalemleri toplar', async () => {
    const old = await seedDefects({ count: 3, label: 'p6-eski', daysAgo: 60 });
    // Aynı tedarikçiye ikinci (yeni) bir parti: seedDefects her çağrıda YENİ tedarikçi üretir,
    // bu yüzden eski partinin tedarikçisini yeniden kullanarak ikinci partiyi elle kuruyoruz.
    const product2 = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const [batch2] = await db
      .insert(schema.batches)
      .values({
        productId: product2.id,
        supplierId: old.supplierId,
        label: `${tagPrefix(tag)}-p6-yeni`,
        qtyReceived: 2,
        receivedAt: new Date(),
      })
      .returning({ id: schema.batches.id });
    const fresh = await insertLicenseItems(db, crypto, {
      productId: product2.id,
      count: 2,
      tag,
      payloadPrefix: 'DEF-p6-yeni',
    });
    await db
      .update(schema.licenseItems)
      .set({ batchId: batch2!.id, status: 'voided' })
      .where(inArray(schema.licenseItems.id, fresh));
    await db.insert(schema.stockAdjustments).values(
      fresh.map((id) => ({
        productId: product2.id,
        licenseItemId: id,
        action: 'damage' as const,
        qty: 1,
        reason: 'yeni kusur',
        actor: ACTOR,
      })),
    );

    // Pencere: son 7 gün → yalnız yeni 2 kalem.
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const within = await claims.candidates({
      supplierId: old.supplierId,
      from,
      reveal: true,
      actor: ACTOR,
    });
    expect(within.rows).toHaveLength(2);

    const created = await claims.create({ supplierId: old.supplierId, from }, ACTOR, true);
    expect(created.itemCount).toBe(2);
    // Eski 3 kalem HÂLÂ havuzda (pencere dışındaydı).
    expect(await poolCount(old.supplierId)).toBe(3);
  });

  it('listeden ÇIKARILAN kalem fişe girmez ve havuzda kalır', async () => {
    const { supplierId, itemIds } = await seedDefects({ count: 3, label: 'p7' });
    const created = await claims.create(
      { supplierId, excludeLicenseItemIds: [itemIds[0]!] },
      ACTOR,
      true,
    );
    expect(created.itemCount).toBe(2);
    expect(await poolCount(supplierId)).toBe(1);
  });

  it('EŞZAMANLI iki fiş isteğinde kalem TEK fişe düşer (advisory-lock)', async () => {
    const { supplierId } = await seedDefects({ count: 5, label: 'p8' });
    const [a, b] = await Promise.allSettled([
      claims.create({ supplierId }, ACTOR, true),
      claims.create({ supplierId }, ACTOR, true),
    ]);
    // Biri 5 kalemi alır, diğeri "kalem yok" ile 400 alır — kalem ASLA bölünmez/çiftlenmez.
    const ok = [a, b].filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    expect((ok[0] as PromiseFulfilledResult<{ itemCount: number }>).value.itemCount).toBe(5);
    expect(await poolCount(supplierId)).toBe(0);

    // Ve kalem başına TEK fiş satırı var (çiftlenme yok) — asıl invaryant budur.
    const dupes = await db.execute(sql`
      SELECT count(*)::int AS c FROM (
        SELECT license_item_id FROM supplier_claim_items
        GROUP BY license_item_id HAVING count(*) FILTER (WHERE outcome <> 'rejected') > 1
      ) d
    `);
    expect(Number((dupes as unknown as Array<{ c: number }>)[0]?.c ?? 0)).toBe(0);
  });
});
