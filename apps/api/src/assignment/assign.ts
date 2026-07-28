import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';

/**
 * db veya transaction (tx) — ikisi de execute() taşır. Atama fonksiyonları hem
 * autocommit (yarış testi) hem transaction (sipariş akışı) içinde çalışır.
 */
export type Executor = Pick<Database, 'execute'>;

/**
 * SATILABİLİRLİK ZAMAN KOŞULU — TEK KAYNAK (§3/§12).
 *
 * Atama sorguları (assignAvailableSingleUse / consumeMultiUseCapacity) süresi geçmiş
 * (`expires_at <= now()`) kalemleri ZATEN dışlıyordu; buna karşın stok TOPLAMLARI
 * (products.list availableStock, ürün detayı, stock.availableCount, stok değerleme…)
 * yalnız `status='available'` bakıyordu → panel ATANAMAYACAK kapasiteyi "satılabilir"
 * gösteriyor, düşük-stok alarmı geç kalıyordu (operatör stok var sanıp sipariş kabul
 * ediyor, teslimat pending'e düşüyor).
 *
 * Bu yüzden koşul TEK yerde tanımlanır ve HEM atama HEM agregasyon yollarında aynen
 * kullanılır — kopyala-yapıştır sapması imkânsız olsun. `alias` sorgudaki tablo adı/
 * takma adıdır (raw SQL'de `li`, drizzle sorgu kurucusunda tablo adı `license_items`).
 *
 * NOT: `expires_at` STOK ÖMRÜdür (FEFO — önce ölecek satılır); atamanın `valid_until`
 * (müşteri lisans süresi) kavramıyla karıştırılmamalıdır.
 */
export function notExpiredCond(alias = 'license_items'): SQL {
  const col = sql.raw(`"${alias}"."expires_at"`);
  return sql`(${col} IS NULL OR ${col} > now())`;
}

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
        AND ${notExpiredCond()}
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
 *
 * `assigned_at` KOŞULLU temizlenir (denetim bulgusu). Eski davranış her geri alımda
 * damgayı NULL'lıyordu; PAYLAŞILAN çok-kullanımlık (MAK) anahtarda bu YANLIŞTI:
 * 500 kullanımlık bir anahtardan 3 birim iade edilince anahtar hâlâ BAŞKA müşterilere
 * teslim edilmiş durumdayken (use_count > 0) "ilk teslim" damgası siliniyor, envanterde
 * "teslim tarihi" boşalıyor ve `assigned_desc` sıralamasında (NULLS LAST) teslim edilmiş
 * anahtar listenin sonuna düşüyordu. Artık damga YALNIZ kalem GERÇEKTEN boşa döndüğünde
 * (kalan kullanım 0) temizlenir.
 *
 * Tek kullanımda davranış BİREBİR aynıdır: max_uses=1 ve use_count=0 olduğu için
 * GREATEST(0, 0−1)=0 → damga NULL'lanır (kalem hiç teslim edilmemiş sayılır, doğrusu budur).
 * `max_uses <= 1` dalı bunu ayrıca AÇIKÇA garanti eder (use_count kenar durumundan bağımsız).
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
        assigned_at = CASE
          WHEN max_uses <= 1 OR GREATEST(0, use_count - ${a.units}) = 0 THEN NULL
          ELSE assigned_at
        END
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
      -- İLK teslimat anını damgala (COALESCE → sonraki kapasite düşümleri damgayı KAYDIRMAZ).
      -- Tek-kullanımda assignAvailableSingleUse zaten yazıyordu; MAK/multi'de hiç yazılmıyordu →
      -- envanter listesinde "teslim tarihi" boş kalıyor ve teslim edilmiş MAK anahtarları
      -- assigned_at sıralamasında hiç görünmüyordu (denetim bulgusu).
      assigned_at = COALESCE(assigned_at, now()),
      status = CASE WHEN use_count + ${units} >= max_uses THEN 'depleted' ELSE status END
    WHERE id = (
      SELECT id FROM license_items
      WHERE product_id = ${productId}
        AND status = 'available'
        AND use_count + ${units} <= max_uses
        AND ${notExpiredCond()}
      ORDER BY expires_at ASC NULLS LAST, created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id;
  `);

  return list.length > 0 ? list[0]!.id : null;
}
