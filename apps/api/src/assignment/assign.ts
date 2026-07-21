import { sql } from 'drizzle-orm';
import type { Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';

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
  const rows = await rawRows<{ id: string }>(db, sql`
    UPDATE license_items SET status = 'assigned', assigned_at = now()
    WHERE id IN (
      SELECT id FROM license_items
      WHERE product_id = ${productId} AND status = 'available'
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY expires_at ASC NULLS LAST, created_at
      LIMIT ${qty}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id;
  `);

  // postgres-js sürücüsünde execute() satır dizisi döner.
  return rows.map((r) => r.id);
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
 * Atamaları geri alır — hem tek kullanımlık (status→available) hem çok kullanımlık
 * (use_count -= units, depleted→available) için. all-or-nothing geri alımında ve
 * revoke'ta kullanılır; multi kapasite sızıntısını önler.
 */
export async function releaseAllocations(
  db: Executor,
  allocations: Array<{ licenseItemId: string; units: number }>,
): Promise<void> {
  for (const a of allocations) {
    await db.execute(sql`
      UPDATE license_items SET
        use_count = GREATEST(0, use_count - ${a.units}),
        status = 'available',
        assigned_at = NULL
      WHERE id = ${a.licenseItemId};
    `);
  }
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
  const list = await rawRows<{ id: string }>(db, sql`
    UPDATE license_items SET
      use_count = use_count + ${units},
      status = CASE WHEN use_count + ${units} >= max_uses THEN 'depleted' ELSE status END
    WHERE id = (
      SELECT id FROM license_items
      WHERE product_id = ${productId}
        AND status = 'available'
        AND use_count + ${units} <= max_uses
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY expires_at ASC NULLS LAST, created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id;
  `);

  return list.length > 0 ? list[0]!.id : null;
}
