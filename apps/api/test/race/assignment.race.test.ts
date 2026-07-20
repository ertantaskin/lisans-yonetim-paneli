import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assignAvailableSingleUse } from '../../src/assignment/assign';
import * as schema from '../../src/db/schema';

/**
 * YARIŞ TESTİ (MIMARI.md §16 — CI'da zorunlu).
 *
 *   100 eşzamanlı sipariş × 50 stok  →  çifte atama = 0
 *
 * FOR UPDATE SKIP LOCKED atomikliğini gerçek PostgreSQL'e karşı kanıtlar.
 * Migration'lar önceden koşmuş olmalı (CI adımı: db:migrate → test:race).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const STOCK = 50;
const CONCURRENT_ORDERS = 100;

// Eşzamanlılığın gerçekten SKIP LOCKED'ı tetiklemesi için ayrı bağlantılar şart.
const client = postgres(DATABASE_URL ?? '', { max: 20 });
const db = drizzle(client, { schema });

let productId: string;

describe('Atomik atama yarış testi (SKIP LOCKED)', () => {
  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL tanımlı değil — yarış testi gerçek PostgreSQL gerektirir.');
    }

    // Bu koşuya özel ürün (izolasyon).
    const runTag = randomUUID().slice(0, 8);
    const [product] = await db
      .insert(schema.products)
      .values({ sku: `race-${runTag}`, name: 'Yarış testi ürünü', kind: 'key' })
      .returning({ id: schema.products.id });
    productId = product!.id;

    // Tam 50 available lisans.
    const items = Array.from({ length: STOCK }, (_, i) => ({
      productId,
      payloadEnc: `enc-${runTag}-${i}`,
      payloadHash: `${runTag}-${i}`,
      status: 'available' as const,
    }));
    await db.insert(schema.licenseItems).values(items);
  });

  afterAll(async () => {
    if (productId) {
      await db.delete(schema.licenseItems).where(sql`product_id = ${productId}`);
      await db.delete(schema.products).where(sql`id = ${productId}`);
    }
    await client.end();
  });

  it(`${CONCURRENT_ORDERS} eşzamanlı sipariş × ${STOCK} stok → çifte atama = 0`, async () => {
    // Her "sipariş" 1 adet ister; hepsi aynı anda yarışır.
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_ORDERS }, () => assignAvailableSingleUse(db, productId, 1)),
    );

    const assignedIds = results.flat();

    // 1) Tam olarak stok kadar atama yapıldı (ne fazla, ne eksik).
    expect(assignedIds.length).toBe(STOCK);

    // 2) ÇİFTE ATAMA = 0 — hiçbir lisans iki siparişe gitmedi.
    const unique = new Set(assignedIds);
    expect(unique.size).toBe(assignedIds.length);

    // 3) Havuzda 'available' kalmadı.
    const remaining = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM license_items
      WHERE product_id = ${productId} AND status = 'available'
    `);
    const remainingCount = Number(
      (remaining as unknown as Array<{ count: string }>)[0]?.count ?? '-1',
    );
    expect(remainingCount).toBe(0);

    // 4) DB'de gerçekten STOCK kadar 'assigned' var.
    const assigned = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM license_items
      WHERE product_id = ${productId} AND status = 'assigned'
    `);
    const assignedCount = Number(
      (assigned as unknown as Array<{ count: string }>)[0]?.count ?? '-1',
    );
    expect(assignedCount).toBe(STOCK);
  });
});
