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
 * "AYAKTA" (canlı) ATAMA STATÜLERİ — TEK KAYNAK, `notExpiredCond` ile aynı gerekçe.
 *
 * NEDEN BURADA (denetim bulgusu R4): aynı kavram en az beş yerde elle yazılmıştı ve
 * kopyalardan biri (`costs.deliveredCogs`) yalnız `'active'` sayıyordu → AYNI EKRANDA
 * satış hızı "şu kadar birim satıldı" derken maliyet raporu daha az birimin maliyetini
 * gösteriyordu. Yüklem tek yerde durur, her tüketici import eder.
 *
 * TANIM:
 *   • `active`    — müşteride, çalışıyor.
 *   • `suspended` — müşteride ama GEÇİCİ gizlenmiş (§4). Teslim EDİLMİŞTİR, iade değildir
 *     (iade ayrı bir statüdür: `revoked`) → teslimat/maliyet defterinden düşmez.
 *   • `expired`   — süreli hesabın ömrü doldu. Yine teslim edilmişti ve §2 gereği "hak geri
 *     gelmez" (kalem havuza dönmez) → maliyeti oluşmuştur.
 * HARİÇ: `revoked` (gerçek iade) ve `replaced` (değişimde net'lenen eski atama) — sayılsalardı
 * iade edilen/değiştirilen anahtar hem satış hem maliyet olarak ÇİFT görünürdü.
 */
export const STANDING_STATUSES: SQL = sql`('active', 'suspended', 'expired')`;

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
 * - Sıra: FEFO (önce ölecek) → sonra FIFO (`created_at`) → tie-break `seq` (ekleme sırası).
 *   `seq` ŞART: bir içe aktarmanın tüm satırları tek transaction'da yazıldığı için
 *   `created_at` hepsinde AYNIDIR; onsuz aynı partiden hangi anahtarın gideceği RASTGELE
 *   olurdu. Artık "önce yapıştırılan önce teslim edilir". Yalnız EŞİTLİĞİ çözer — hangi
 *   satırların uygun olduğunu değiştirmez, SKIP LOCKED davranışına dokunmaz.
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
      ORDER BY expires_at ASC NULLS LAST, created_at, seq
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
  if (allocations.length === 0) return;

  // PERF: TEK ifade. Eskiden kalem başına ayrı UPDATE atılıyordu ve bu yol tam da STOK
  // YETMEDİĞİNDE (all-or-nothing geri alımı) tetiklenir: qty=5.000'lik bir satırda önce
  // 5.000 satır tek ifadeyle 'assigned' yapılıp ardından 5.000 AYRI UPDATE ile geri veriliyordu
  // — transaction açık, kilitler tutuluyor ve süre `idle_in_transaction_session_timeout` (60 sn)
  // ile Fastify `requestTimeout` (30 sn) mertebesine yaklaşıyordu.
  //
  // Aynı kalem birden çok allocation'da geçerse ÖNCE toplanır: `UPDATE … FROM (VALUES …)`
  // bir satırı yalnız BİR KEZ günceller, yani toplamadan yazmak sessizce eksik geri verirdi.
  // GREATEST(0, …) monoton olduğu için toplama, ardışık düşümle birebir aynı sonucu verir.
  const totals = new Map<string, number>();
  for (const a of allocations) {
    totals.set(a.licenseItemId, (totals.get(a.licenseItemId) ?? 0) + a.units);
  }

  const values = sql.join(
    [...totals].map(([id, units]) => sql`(${id}::uuid, ${units}::int)`),
    sql`, `,
  );

  await db.execute(sql`
    UPDATE license_items li SET
      use_count = GREATEST(0, li.use_count - v.units),
      status = 'available',
      assigned_at = CASE
        WHEN li.max_uses <= 1 OR GREATEST(0, li.use_count - v.units) = 0 THEN NULL
        ELSE li.assigned_at
      END
    FROM (VALUES ${values}) AS v(id, units)
    WHERE li.id = v.id;
  `);
}

/** Tek bir MAK/çok-kullanımlık anahtardan alınan kapasite. */
export interface MultiUseTake {
  licenseItemId: string;
  /** Bu çağrıda GERÇEKTEN düşülen birim (1..want) — anahtarın kalanıyla sınırlı. */
  taken: number;
}

/**
 * Çok kullanımlık (multi / MAK) kapasite düşümü (§2). Satır seçmek yerine kilitli
 * tek satırda use_count += LEAST(want, kalan). Kapasite aşımı imkânsız (`taken`
 * tanımı gereği kalanı geçemez, satır `FOR UPDATE` ile kilitliyken hesaplanır).
 *
 * PERF (denetim bulgusu): eskiden bu fonksiyon "hepsi ya da hiç" idi (`use_count +
 * units <= max_uses`) ve `allocate()` onu BİRİM BAŞINA çağırıyordu → 200 adetlik bir
 * MAK satırı tek transaction içinde 200 sıralı UPDATE gidiş-dönüşü demekti; kilitler
 * o süre boyunca tutulduğu için eşzamanlı siparişlerde çekişme katlanıyordu. Artık
 * çağıran ANAHTAR başına döner, birim başına değil.
 *
 * @returns düşülen anahtar + alınan birim; hiç kapasite yoksa null
 */
export async function consumeMultiUseCapacity(
  db: Executor,
  productId: string,
  want: number,
): Promise<MultiUseTake | null> {
  if (want <= 0) return null;
  const list = await rawRows<{ id: string; taken: number }>(db, sql`
    WITH picked AS (
      -- Alınacak birim TEK anahtarın KALAN kapasitesiyle sınırlıdır: LEAST(istenen, kalan).
      -- Eski sürüm "hepsi ya da hiç" (use_count + want <= max_uses) idi ve çağıran her
      -- BİRİM için ayrı çağrı yapıyordu; artık kalan ne kadarsa o kadar alınır, dolayısıyla
      -- 200 birimlik bir MAK satırı 200 değil ~1 gidiş-dönüşte karşılanır. Dağılım aynı:
      -- FEFO sırasındaki ilk anahtar doldurulur, artan talep sonraki anahtara taşar.
      SELECT id, LEAST(${want}, max_uses - use_count) AS taken
      FROM license_items
      WHERE product_id = ${productId}
        AND status = 'available'
        AND use_count < max_uses
        AND ${notExpiredCond()}
      ORDER BY expires_at ASC NULLS LAST, created_at, seq
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE license_items li SET
      use_count = li.use_count + p.taken,
      -- İLK teslimat anını damgala (COALESCE → sonraki kapasite düşümleri damgayı KAYDIRMAZ).
      -- Tek-kullanımda assignAvailableSingleUse zaten yazıyordu; MAK/multi'de hiç yazılmıyordu →
      -- envanter listesinde "teslim tarihi" boş kalıyor ve teslim edilmiş MAK anahtarları
      -- assigned_at sıralamasında hiç görünmüyordu (denetim bulgusu).
      assigned_at = COALESCE(li.assigned_at, now()),
      status = CASE WHEN li.use_count + p.taken >= li.max_uses THEN 'depleted' ELSE li.status END
    FROM picked p
    -- DİKKAT: taken CTE'de, yani GÜNCELLEMEDEN ÖNCEKİ satırdan hesaplanır. RETURNING içinde
    -- max_uses - use_count yazmak YANLIŞ olurdu: Postgres RETURNING'de UPDATE SONRASI
    -- (NEW) değerleri döndürür → alınan birim yerine kalan kapasite dönerdi.
    -- (Bu blok bir SQL şablon dizesinin içindedir; yorumlarda ters tırnak KULLANMA.)
    WHERE li.id = p.id
    RETURNING li.id, p.taken AS taken;
  `);

  const row = list[0];
  return row ? { licenseItemId: row.id, taken: Number(row.taken) } : null;
}
