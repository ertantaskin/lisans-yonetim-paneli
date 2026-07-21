import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CustomerRisk } from '@jetlisans/shared';
import { RiskScoreService } from '../../src/security/risk-score.service';
import * as schema from '../../src/db/schema';
import type { Database } from '../../src/db/db.module';
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
 * ENTEGRASYON — RiskScoreService (§8/§9) advisory risk skoru, gerçek PostgreSQL'e karşı.
 *
 * Servis OKUMA-ANINDA türetir (yazma/eylem YOK); mevcut tabloları (customers/orders/assignments/
 * replacement_requests/security_events) salt-okunur okur. Bu yüzden formülü test etmek için
 * gerçek satır seed'lenir. Nest ayağa KALDIRILMAZ: servis elle new'lenir (gerçek db).
 *
 * Deterministiklik: band/etiket senaryoları YALNIZ customers.tags seed'ler ve sipariş EKLEMEZ
 * → recency/security/replacement faktörleri 0 kalır, skor = etiket katkısı (izole eşik testi).
 * Aktivite senaryoları sipariş/atama/değişim seed'ler.
 *
 * İZOLASYON: cleanupByTag customers'ı KAPSAMAZ (orders FK'siyle bağlı değil) → e-postalara tag
 * gömülür ve afterAll'da elle silinir. replacement_requests, orders'a (cascade) ve sites'a
 * (cascade) bağlı → cleanupByTag orders/sites silerken düşer.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let svc: RiskScoreService;

/** Kalıcı müşteri meta'sı (yalnız etiketler) ekler — e-posta lowercase + tag gömülü. */
async function insertCustomer(email: string, tags: string[]): Promise<void> {
  await db.insert(schema.customers).values({ email, tags });
}

/** Verilen sipariş satırına bir aktif atama ekler. */
async function insertAssignment(orderId: string, lineId: string, licenseItemId: string): Promise<void> {
  await db.insert(schema.assignments).values({
    orderId,
    lineId,
    licenseItemId,
    status: 'active',
    units: 1,
  });
}

/**
 * Bir müşteriye gerçek aktivite seed'ler: site + ürün + sipariş (customer_email) + N atama
 * (N license item) + M onaylı değişim talebi. assignmentCount=N, replacementCount=M olur.
 */
async function seedActivity(opts: {
  email: string;
  assignments: number;
  replacements: number;
}): Promise<void> {
  const site = await createSite(db, crypto, { tag });
  const product = await createProduct(db, { tag });
  const order = await createOrderWithLine(db, {
    siteId: site.id,
    productId: product.id,
    qty: opts.assignments,
    tag,
    customerEmail: opts.email,
  });
  const itemIds = await insertLicenseItems(db, crypto, {
    productId: product.id,
    count: opts.assignments,
    tag,
    status: 'assigned',
  });
  for (const itemId of itemIds) {
    await insertAssignment(order.orderId, order.lineId, itemId);
  }
  for (let i = 0; i < opts.replacements; i += 1) {
    await db.insert(schema.replacementRequests).values({
      siteId: site.id,
      orderId: order.orderId,
      lineId: order.lineId,
      customerEmail: opts.email,
      reason: `it-test değişim ${i}`,
      status: 'approved',
    });
  }
}

/** Yardımcı: yanıttan tek bir faktörü anahtarıyla çeker. */
function factor(risk: CustomerRisk, key: string) {
  const f = risk.factors.find((x) => x.key === key);
  expect(f, `faktör bulunamadı: ${key}`).toBeDefined();
  return f!;
}

describe('RiskScoreService.scoreCustomer (advisory risk)', () => {
  beforeAll(async () => {
    const h = makeDb();
    db = h.db;
    end = h.end;
    crypto = makeCrypto();
    svc = new RiskScoreService(db as unknown as Database);
  });

  afterAll(async () => {
    // customers cleanupByTag kapsamında değil — tag'li e-postaları elle sil (önce, FK'siz).
    await db.execute(sql`DELETE FROM customers WHERE email LIKE ${`%${tag}%`}`);
    await cleanupByTag(db, tag);
    await end();
  });

  it('anonimleştirilmiş müşteri (@redacted.invalid) → nötr (0/low, no_data)', async () => {
    const risk = await svc.scoreCustomer('deadbeef@redacted.invalid');
    expect(risk.score).toBe(0);
    expect(risk.band).toBe('low');
    expect(risk.factors[0]?.key).toBe('no_data');
  });

  it('bulunamayan müşteri (sipariş+meta yok) → nötr (0/low, no_data)', async () => {
    const risk = await svc.scoreCustomer(`bulunmaz-${tag}@example.test`);
    expect(risk.score).toBe(0);
    expect(risk.band).toBe('low');
    expect(risk.factors.some((f) => f.key === 'no_data')).toBe(true);
  });

  it("etiket 'risky' (30) → skor 30, band LOW (<34 eşik altı)", async () => {
    const email = `risky-${tag}@example.test`;
    await insertCustomer(email, ['risky']);
    const risk = await svc.scoreCustomer(email);
    expect(factor(risk, 'tags').contribution).toBe(30);
    expect(risk.score).toBe(30);
    expect(risk.band).toBe('low');
  });

  it("etiket 'blocked' (50) → skor 50, band MEDIUM (34-66 arası)", async () => {
    const email = `blocked-${tag}@example.test`;
    await insertCustomer(email, ['blocked']);
    const risk = await svc.scoreCustomer(email);
    expect(factor(risk, 'tags').contribution).toBe(50);
    expect(risk.score).toBe(50);
    expect(risk.band).toBe('medium');
  });

  it("etiket 'blocked'+'wholesale' (50-15=35) → skor 35, band MEDIUM (34 eşiği kapsanır)", async () => {
    const email = `bw-${tag}@example.test`;
    await insertCustomer(email, ['blocked', 'wholesale']);
    const risk = await svc.scoreCustomer(email);
    expect(factor(risk, 'tags').contribution).toBe(35);
    expect(risk.score).toBe(35);
    expect(risk.band).toBe('medium');
  });

  it("etiket 'blocked'+'risky' (80) → skor 80, band HIGH (>=67 eşik)", async () => {
    const email = `br-${tag}@example.test`;
    await insertCustomer(email, ['blocked', 'risky']);
    const risk = await svc.scoreCustomer(email);
    expect(factor(risk, 'tags').contribution).toBe(80);
    expect(risk.score).toBe(80);
    expect(risk.band).toBe('high');
  });

  it("etiket 'vip' (-25) → clamp alt sınır: skor 0/low (katkı -25 kalır)", async () => {
    const email = `vip-${tag}@example.test`;
    await insertCustomer(email, ['vip']);
    const risk = await svc.scoreCustomer(email);
    // Faktör katkısı ham negatif; skor 0'a clamp'lenir.
    expect(factor(risk, 'tags').contribution).toBe(-25);
    expect(risk.score).toBe(0);
    expect(risk.band).toBe('low');
  });

  it('değişim oranı formülü: 4 atama / 2 onaylı değişim (r=0.5) → katkı 15', async () => {
    const email = `rate-${tag}@example.test`;
    await seedActivity({ email, assignments: 4, replacements: 2 });
    const risk = await svc.scoreCustomer(email);
    // over = (0.5 - 0.25) / 0.75 = 0.3333…; *45 = 15 (round).
    expect(factor(risk, 'replacement_rate').contribution).toBe(15);
  });

  it('MIN_ASSIGNMENTS koruması: 2 atama (<3) yüksek oranla bile → değişim katkısı 0', async () => {
    const email = `min-${tag}@example.test`;
    await seedActivity({ email, assignments: 2, replacements: 2 });
    const risk = await svc.scoreCustomer(email);
    const f = factor(risk, 'replacement_rate');
    expect(f.contribution).toBe(0);
    expect(f.detail).toContain('Yetersiz veri');
  });

  it('clamp üst sınır: blocked+risky (80) + tam değişim oranı (45) + recency → skor 100', async () => {
    const email = `max-${tag}@example.test`;
    await insertCustomer(email, ['blocked', 'risky']);
    // 3 atama / 3 onaylı değişim → r=1 → değişim katkısı 45 (tavan). Yeni sipariş → recency ekler.
    await seedActivity({ email, assignments: 3, replacements: 3 });
    const risk = await svc.scoreCustomer(email);
    expect(factor(risk, 'replacement_rate').contribution).toBe(45);
    expect(factor(risk, 'tags').contribution).toBe(80);
    // Ham toplam 80+45+recency > 100 → 100'e clamp.
    expect(risk.score).toBe(100);
    expect(risk.band).toBe('high');
  });
});
