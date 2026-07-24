import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { AdminOrdersService } from '../../src/orders/admin-orders.service';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { MailService } from '../../src/mail/mail.service';
import { ProductsService } from '../../src/products/products.service';
import { WebhookService } from '../../src/webhook/webhook.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createOrderWithLine,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  type CreatedSite,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — AdminOrdersService.replaceAssignment (§4 admin PROAKTİF değişim + §3 assignment_history).
 *
 * Değişim makinesi (revoke markLineCanceled=FALSE + completeLine) doğrudan admin tarafından
 * tetiklenir; iade DEĞİL → satır 'canceled' işaretlenmez, meşru yeniden-atama yapılır ve eski→yeni
 * soyağacı assignment_history'ye yazılır. Stok yoksa eski atama KORUNUR (409); MAK reddedilir.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let admin: AdminOrdersService;
let fulfillment: FulfillmentService;
let site: CreatedSite;
const ACTOR = 'it-replace-actor';

/** Teslim edilmiş tek atama kurar (item 'assigned', aktif atama, satır fulfilled). */
async function seedDelivered(productId: string, licenseItemId: string) {
  const order = await createOrderWithLine(db, { siteId: site.id, productId, qty: 1, tag, status: 'fulfilled' });
  await db
    .update(schema.licenseItems)
    .set({ status: 'assigned', assignedAt: new Date() })
    .where(eq(schema.licenseItems.id, licenseItemId));
  const [asg] = await db
    .insert(schema.assignments)
    .values({ orderId: order.orderId, lineId: order.lineId, licenseItemId, units: 1, status: 'active', deliveredAt: new Date() })
    .returning({ id: schema.assignments.id });
  await db
    .update(schema.orderLines)
    .set({ fulfilledQty: 1, status: 'fulfilled' })
    .where(eq(schema.orderLines.id, order.lineId));
  return { orderId: order.orderId, lineId: order.lineId, assignmentId: asg!.id };
}

describe('AdminOrdersService.replaceAssignment (proaktif değişim + soyağacı)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    const fakeQueue = { add: async () => undefined } as unknown as Queue;
    const fakeRedis = {} as unknown as Redis;
    const fakeConfig = { get: () => undefined, getOrThrow: () => '' } as never;
    const products = new ProductsService(db as never);
    const mail = new MailService(db as never, fakeQueue, fakeConfig);
    const webhook = new WebhookService(db as never, fakeQueue);
    fulfillment = new FulfillmentService(db as never, products, mail, webhook);
    admin = new AdminOrdersService(db as never, fakeRedis, crypto, mail, fulfillment);
    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('stok VARKEN → old karantina, satırda YENİ+FARKLI aktif atama, canceled=FALSE, history yazılır', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const [itemA, itemB] = await insertLicenseItems(db, crypto, { productId: product.id, count: 2, tag });
    const seed = await seedDelivered(product.id, itemA!); // A teslim, B yedek available

    const res = await admin.replaceAssignment(seed.assignmentId, 'kusurlu key', ACTOR);
    expect(res.status).toBe('replaced');
    expect(res.newAssignmentId).toBeTruthy();

    // Eski atama revoked + itemA karantina.
    const [oldAsg] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.id, seed.assignmentId))
      .limit(1);
    expect(oldAsg!.status).toBe('revoked');
    const [ia] = await db
      .select({ status: schema.licenseItems.status })
      .from(schema.licenseItems)
      .where(eq(schema.licenseItems.id, itemA!))
      .limit(1);
    expect(ia!.status).toBe('quarantined');

    // Satırda YENİ aktif atama FARKLI (B) key.
    const [newAsg] = await db
      .select({ id: schema.assignments.id, licenseItemId: schema.assignments.licenseItemId })
      .from(schema.assignments)
      .where(and(eq(schema.assignments.lineId, seed.lineId), eq(schema.assignments.status, 'active')))
      .orderBy(desc(schema.assignments.createdAt))
      .limit(1);
    expect(newAsg!.id).toBe(res.newAssignmentId);
    expect(newAsg!.licenseItemId).toBe(itemB);

    // Satır 'canceled' DEĞİL (değişim, iade değil).
    const [line] = await db
      .select({ canceled: schema.orderLines.canceled })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, seed.lineId))
      .limit(1);
    expect(line!.canceled).toBe(false);

    // assignment_history: eski→yeni satırı yazıldı (§3 "eski anahtarlar").
    const [hist] = await db
      .select({
        assignmentId: schema.assignmentHistory.assignmentId,
        oldLicenseItemId: schema.assignmentHistory.oldLicenseItemId,
        newLicenseItemId: schema.assignmentHistory.newLicenseItemId,
        actor: schema.assignmentHistory.actor,
      })
      .from(schema.assignmentHistory)
      .where(eq(schema.assignmentHistory.assignmentId, res.newAssignmentId!))
      .limit(1);
    expect(hist).toBeDefined();
    expect(hist!.oldLicenseItemId).toBe(itemA);
    expect(hist!.newLicenseItemId).toBe(itemB);
    expect(hist!.actor).toBe(ACTOR);
  });

  it('stok YOKKEN → ConflictException; eski atama KORUNUR (revoke edilmez), history yazılmaz', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const [only] = await insertLicenseItems(db, crypto, { productId: product.id, count: 1, tag }); // yedek yok
    const seed = await seedDelivered(product.id, only!);

    await expect(admin.replaceAssignment(seed.assignmentId, 'kusurlu', ACTOR)).rejects.toBeInstanceOf(
      ConflictException,
    );
    const [asg] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.id, seed.assignmentId))
      .limit(1);
    expect(asg!.status).toBe('active');
  });

  it('MULTI/MAK → BadRequestException (otomatik değişim desteklenmez)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'multi', maxUses: 500 });
    const [item] = await insertLicenseItems(db, crypto, { productId: product.id, count: 1, tag, maxUses: 500 });
    const seed = await seedDelivered(product.id, item!);
    await expect(admin.replaceAssignment(seed.assignmentId, 'x', ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('F1 REGRESYON: all-or-nothing 3/6 satırda tek-birim değişim TAZE key verir (409 DEĞİL)', async () => {
    // #7 ile eklenen "completeLine all-or-nothing'i onurlandırır" guard'ı, maxUnits verilen SINIRLI
    // değişim top-up'ını da bloke ediyordu: kısmen teslim (3/6, #16 re-push adet artışıyla erişilebilir)
    // all-or-nothing satırda tek birim değiştirilince `fulfilled+1 < qty` → taze key serbest bırakılıp
    // "Değişim için stok yok" 409 atılıyordu; eski key zaten karantinada → müşteri parasını ödediği
    // lisansı KAYBEDERDİ. F1: hedef sınırlı top-up'ta min(qty, fulfilled+toAssign) → guard artık tetiklenmez.
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'all-or-nothing',
    });
    // 3 teslim edilmiş ('assigned') + 3 yedek ('available') key — değişim yedek havuzundan seçer.
    const delivered = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 3,
      tag,
      status: 'assigned',
      payloadPrefix: 'DELIVERED',
    });
    await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 3,
      tag,
      payloadPrefix: 'SPARE',
    });

    // qty=6, fulfilledQty=3 → kısmen dolmuş all-or-nothing satır (3 aktif atama).
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 6,
      tag,
      status: 'partial',
    });
    const asgRows = await db
      .insert(schema.assignments)
      .values(
        delivered.map((liId) => ({
          orderId: order.orderId,
          lineId: order.lineId,
          licenseItemId: liId,
          units: 1,
          status: 'active' as const,
          deliveredAt: new Date(),
        })),
      )
      .returning({ id: schema.assignments.id });
    await db
      .update(schema.orderLines)
      .set({ fulfilledQty: 3, status: 'partial' })
      .where(eq(schema.orderLines.id, order.lineId));

    // Teslim edilmiş bir birimi değiştir → TAZE key atanmalı (regresyondan önce 409 atardı).
    const targetAsg = asgRows[0]!.id;
    const res = await admin.replaceAssignment(targetAsg, 'kusurlu key', ACTOR);
    expect(res.status).toBe('replaced');
    expect(res.newAssignmentId).toBeTruthy();

    // Eski atama revoked.
    const [oldAsg] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.id, targetAsg))
      .limit(1);
    expect(oldAsg!.status).toBe('revoked');

    // Satırda 3 aktif atama (2 kalan + 1 taze), yenisi res.newAssignmentId.
    const active = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(
        and(eq(schema.assignments.lineId, order.lineId), eq(schema.assignments.status, 'active')),
      );
    expect(active.length).toBe(3);
    expect(active.some((a) => a.id === res.newAssignmentId)).toBe(true);

    // Satır canceled DEĞİL (değişim, iade değil), fulfilledQty 3'e döndü, hâlâ partial.
    const [line] = await db
      .select({
        canceled: schema.orderLines.canceled,
        fulfilledQty: schema.orderLines.fulfilledQty,
        status: schema.orderLines.status,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, order.lineId))
      .limit(1);
    expect(line!.canceled).toBe(false);
    expect(line!.fulfilledQty).toBe(3);
    expect(line!.status).toBe('partial');
  });

  it('2. DENETİM REGRESYONU: manuel "N Adet Ata" all-or-nothing satırı KISMEN teslim ETMEZ (§5)', async () => {
    // F1 hedef-farkında rölaks YALNIZ değişim (isReplacement) top-up'ında geçerli olmalı. Manuel
    // POST /admin/fulfillments/:lineId/complete?units=N ucu revoke YAPMADAN (isReplacement=false)
    // completeLine(lineId, N) çağırır; bir all-or-nothing satırda N < kalan ise HİÇBİR ŞEY atanmamalı
    // (§5 "all-or-nothing satırda kısmi teslim YASAK"). Regresyondan önce 3/5 kısmen teslim ediyordu.
    const product = await createProduct(db, {
      tag,
      kind: 'key',
      usageMode: 'single',
      fulfillmentPolicy: 'all-or-nothing',
    });
    await insertLicenseItems(db, crypto, { productId: product.id, count: 3, tag }); // yalnız 3 stok
    // qty=5, fulfilledQty=0 → boş all-or-nothing satır (kalan 5 > eldeki 3).
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 5,
      tag,
      status: 'pending',
    });

    // Manuel N=3 ata (isReplacement=false): 3 < 5 → all-or-nothing → hiçbir şey atanmaz, kapasite iade.
    const res = await fulfillment.completeLine(order.lineId, 3);
    expect(res.added).toBe(0);
    expect(res.status).toBe('pending');

    // Satırda aktif atama YOK.
    const active = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(
        and(eq(schema.assignments.lineId, order.lineId), eq(schema.assignments.status, 'active')),
      );
    expect(active.length).toBe(0);

    // Stok tüketilmedi — 3 key hâlâ 'available' (kısmi ayırma geri bırakıldı).
    const avail = await db
      .select({ id: schema.licenseItems.id })
      .from(schema.licenseItems)
      .where(
        and(
          eq(schema.licenseItems.productId, product.id),
          eq(schema.licenseItems.status, 'available'),
        ),
      );
    expect(avail.length).toBe(3);
  });
});
