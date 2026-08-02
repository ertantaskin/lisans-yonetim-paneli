import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
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
  createProduct,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — M1: karantina listesi rol-farkında maskeleme (denetim A1/M1).
 *
 * A1 kararı: düz-metin lisans YALNIZ owner'a; owner-OLMAYAN admin MASKELİ görür. listQuarantine
 * eskiden `reveal`'a bakmadan TAM düz anahtar döndürüyordu. Bu test iki yolu kilitler:
 *   · reveal=true (owner / auth KAPALI) → keyPreview TAM düz metin (tag içerir) + reveal audit'i yazılır.
 *   · reveal=false (owner-olmayan admin) → keyPreview MASKELİ (••••••+son-4; tag İÇERMEZ) + audit YAZILMAZ.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let admin: AdminOrdersService;

describe('M1 karantina listesi rol-farkında maske (listQuarantine reveal)', () => {
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
    const fulfillment = new FulfillmentService(db as never, products, mail, webhook);
    admin = new AdminOrdersService(db as never, fakeRedis, crypto, mail, fulfillment);
  });

  afterAll(async () => {
    // reveal audit kaydını (bu koşuya özel actor) temizle + tag kapsamı.
    await db.execute(sql`DELETE FROM audit_log WHERE actor = ${`panel:qmask-${tag}`}`);
    await cleanupByTag(db, tag);
    await end();
  });

  it('reveal=true → tam düz anahtar; reveal=false → maskeli (tag sızmaz)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    const [itemId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      payloadPrefix: 'QMASK',
    });
    // Karantinaya al (ölü/geçersiz anahtar).
    await db
      .update(schema.licenseItems)
      .set({ status: 'quarantined' })
      .where(eq(schema.licenseItems.id, itemId!));

    // OWNER (reveal=true): TAM düz metin — plaintext tag'i içerir.
    const revealed = await admin.listQuarantine({
      productId: product.id,
      reveal: true,
      actor: `panel:qmask-${tag}`,
    });
    const revealedRow = revealed.rows.find((r) => r.licenseItemId === itemId);
    expect(revealedRow).toBeTruthy();
    expect(revealedRow!.keyPreview).toContain(tag);
    expect(revealedRow!.keyPreview).not.toContain('•'); // maske gövdesi yok

    // OWNER-OLMAYAN (reveal=false): MASKELİ — bullet gövdesi var, tag SIZMAZ.
    const masked = await admin.listQuarantine({
      productId: product.id,
      reveal: false,
      actor: `panel:qmask-${tag}`,
    });
    const maskedRow = masked.rows.find((r) => r.licenseItemId === itemId);
    expect(maskedRow).toBeTruthy();
    expect(maskedRow!.keyPreview).toContain('•'); // ••••••
    expect(maskedRow!.keyPreview).not.toContain(tag);
  });
});
