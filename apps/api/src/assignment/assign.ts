import { sql } from 'drizzle-orm';
import type { Database } from '../db/db.module';

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
  db: Database,
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
 * Çok kullanımlık (multi / MAK) kapasite düşümü (§2). Satır seçmek yerine kilitli
 * tek satırda use_count += units (koşul: use_count + units <= max_uses).
 * Kapasite aşımı imkânsız.
 *
 * @returns kapasitesi düşülen license_item id'si, yeterli kapasite yoksa null
 */
export async function consumeMultiUseCapacity(
  db: Database,
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
