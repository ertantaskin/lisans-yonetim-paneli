import { sql } from 'drizzle-orm';
import type { Database } from '../db/db.module';

/**
 * db veya transaction (tx) — ikisi de execute() taşır. Atama fonksiyonları hem
 * autocommit (yarış testi) hem transaction (sipariş akışı) içinde çalışır.
 */
export type Executor = Pick<Database, 'execute'>;

/**
 * Atomik stok atama — sistemin kalbi (MIMARI.md §2).
 *
 *   UPDATE license_items SET status='assigned', assigned_at=now()
 *   WHERE id IN (
 *     SELECT id FROM license_items
 *     WHERE product_id = $1 AND status = 'available'
 *     ORDER BY created_at LIMIT $2
 *     FOR UPDATE SKIP LOCKED)
 *   RETURNING id;
 *
 * - FOR UPDATE SKIP LOCKED: eşzamanlı siparişler farklı satır kilitler; aynı satır
 *   iki kez seçilemez, deadlock yok. Çifte atama İMKÂNSIZ.
 * - Kısmi teslimatta istenen adetten az dönebilir (stok yetersiz) — çağıran taraf
 *   ürün politikasına göre (§5) kalanı pending bırakır.
 *
 * @returns atanan license_item id listesi (0..qty adet)
 */
export async function assignAvailableSingleUse(
  db: Executor,
  productId: string,
  qty: number,
): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE license_items SET status = 'assigned', assigned_at = now()
    WHERE id IN (
      SELECT id FROM license_items
      WHERE product_id = ${productId} AND status = 'available'
      ORDER BY created_at
      LIMIT ${qty}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id;
  `);

  // postgres-js sürücüsünde execute() satır dizisi döner.
  return (rows as unknown as Array<{ id: string }>).map((r) => r.id);
}

/**
 * Atanmış satırları tekrar 'available' yapar (all-or-nothing politikasında stok
 * yetersizse geri alma). Aynı transaction içinde çağrılır.
 */
export async function releaseToAvailable(db: Executor, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.execute(sql`
    UPDATE license_items SET status = 'available', assigned_at = NULL
    WHERE id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )});
  `);
}

/**
 * Çok kullanımlık (multi / MAK) kapasite düşümü (§2). Satır seçmek yerine kilitli
 * tek satırda use_count += units (koşul: use_count + units <= max_uses).
 * Kapasite aşımı imkânsız.
 *
 * @returns kapasitesi düşülen license_item id'si, yeterli kapasite yoksa null
 */
export async function consumeMultiUseCapacity(
  db: Executor,
  productId: string,
  units: number,
): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE license_items SET
      use_count = use_count + ${units},
      status = CASE WHEN use_count + ${units} >= max_uses THEN 'depleted' ELSE status END
    WHERE id = (
      SELECT id FROM license_items
      WHERE product_id = ${productId}
        AND status = 'available'
        AND use_count + ${units} <= max_uses
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id;
  `);

  const list = rows as unknown as Array<{ id: string }>;
  return list.length > 0 ? list[0]!.id : null;
}
