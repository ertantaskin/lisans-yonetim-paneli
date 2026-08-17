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
  /*
   * ── CTE ŞART: `IN (alt sorgu ... LIMIT n FOR UPDATE SKIP LOCKED)` AŞIRI TESLİMAT ÜRETİR ──
   *
   * Eski hâli `UPDATE license_items WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)`
   * idi ve ÖLÇÜLDÜ (entegrasyon paketinde ~3 koşumda 1, izole PostgreSQL'de, tek süreçte):
   * `qty=6` istenirken sorgu **20** satır (o ürünün TÜM stoğu) döndürdü ve hepsi tek sipariş
   * satırına atandı — motorun kendi olayı `+20 atandı (20/6)` yazdı. Yani sistemin kalbindeki
   * "istenen kadar ata" sözü bazen tutulmuyordu: müşteriye bedava lisans, envanterden sessiz
   * yanma. Aralıklı olduğu için aylarca "testler bazen kırmızı" gürültüsü sanılmıştı.
   *
   * NEDEN: READ COMMITTED'da UPDATE hedef satırı eşzamanlı değiştirilmiş bulursa satırın YENİ
   * sürümü üzerinde WHERE'i yeniden değerlendirir (EvalPlanQual) ve `IN (...)` alt sorgusu
   * YENİDEN KOŞAR. Alt sorgu her koşuda "ilk n"i baştan seçer; `SKIP LOCKED` ile o an kilitli
   * olanlar atlandığı için farklı bir küme döner ve BİRLEŞİMİ güncellenir → LIMIT fiilen
   * kalkar. Kuyruk desenlerinde bilinen tuzak budur; doğrusu alt sorguyu BİR KEZ maddeleştiren
   * CTE'dir. MAK yolu (`consumeMultiUseCapacity`) CTE kullanıyordu ama `MATERIALIZED` DEMİYORDU
   * — yani aynı kurala göre o da açıktaydı (sonradan düzeltildi; oradaki nota bak).
   *
   * `MATERIALIZED` AÇIKÇA yazılır: tek kez referans edilen bir CTE'yi planlayıcı satır içine
   * alabilir (inline) ve tuzak geri gelirdi.
   */
  const rows = await rawRows<{ id: string }>(db, sql`
    WITH picked AS MATERIALIZED (
      SELECT id FROM license_items
      WHERE product_id = ${productId} AND status = 'available'
        AND ${notExpiredCond()}
      ORDER BY expires_at ASC NULLS LAST, created_at, seq
      LIMIT ${qty}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE license_items li SET status = 'assigned', assigned_at = now()
    FROM picked p
    WHERE li.id = p.id
    RETURNING li.id;
  `);

  // postgres-js sürücüsünde execute() satır dizisi döner.
  const ids = rows.map((r) => r.id);

  /*
   * FAIL-CLOSED KALKAN: istenenden ÇOK satır dönmesi imkânsız olmalı; olursa bu sessizce
   * bedava lisans demektir. Transaction'ı patlatmak (rollback) yanlış teslimattan İYİDİR —
   * yukarıdaki arıza sınıfı tam da "sessiz" olduğu için uzun süre fark edilmemişti.
   */
  if (ids.length > qty) {
    throw new Error(
      `Atama invaryantı ihlali: ${qty} birim istendi, ${ids.length} kalem atandı ` +
        `(ürün ${productId}). İşlem geri alındı.`,
    );
  }
  return ids;
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

  // CHUNK: PostgreSQL Bind mesajı parametre sayısını int16'da taşır (65535). Satır başına 2
  // parametre → ~32.767 satırda `MAX_PARAMETERS_EXCEEDED`. Tek ifadeye geçiş bu tavanı YENİ
  // getirdi (eski döngüde yoktu), bu yüzden bilerek sınırlanır; 5.000 × 2 = 10.000 parametre.
  // Aynı desen `assignment-insert.ts` ve katalog senkronunda da uygulanıyor.
  const entries = [...totals];
  const CHUNK = 5000;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const values = sql.join(
      entries.slice(i, i + CHUNK).map(([id, units]) => sql`(${id}::uuid, ${units}::int)`),
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
 * ── DAĞITIM KURALI: "önce TALEBİ TEK BAŞINA KARŞILAYAN anahtar" (kullanıcı kararı) ──
 *
 * Eski sıralama yalnız FEFO/FIFO idi: ilk anahtar kalanı kadar verir, artan talep sonrakine
 * TAŞAR. Bu, kapasite muhasebesi açısından doğruydu ama müşteriye GEREKSİZ yere birden çok
 * anahtar gönderiyordu — 6 birimlik bir sipariş, 10 kapasiteli boş bir anahtar dururken
 * "5 kalanı olan anahtardan 5 + yeni anahtardan 1" biçiminde bölünebiliyordu.
 *
 * İKİ SOMUT ZARARI vardı: (a) müşteri iki anahtar görüyor ve HANGİSİNİ kaç kez
 * etkinleştirebileceğini bilmiyor; (b) MAK'ta anahtarın kendisi paylaşımlıdır — panel
 * yalnız DEFTER tutar, teknik olarak müşteriyi anahtarın kalan kapasitesini kullanmaktan
 * alıkoyan bir şey yoktur; dolayısıyla müşterinin eline geçen her FAZLADAN anahtar, fazladan
 * aşırı-etkinleştirme yüzeyidir. Bu yüzden hedef: sipariş başına EN AZ sayıda anahtar.
 *
 * Sıralamanın BİRİNCİ anahtarı artık "kalan kapasitesi tek başına talebi karşılıyor mu";
 * FEFO (`expires_at`) ve FIFO (`created_at, seq`) AYNEN ikinci/üçüncü anahtar olarak durur.
 * Sonuçlar:
 *   • karşılayan anahtar varsa → TEK anahtar, TEK atama ("aynı anahtarı N kez etkinleştir").
 *   • karşılayan yoksa → ESKİ davranış birebir (FEFO ilk anahtarı doldur, kalanı taşır).
 *   • küçük talep, yarım kalmış anahtarı da "karşılayan" yapar ve FIFO onu ÖNCE seçer →
 *     parça kapasiteler çürümez, doldurulur.
 * FEFO'nun zayıfladığı TEK durum: süresi yakın bir anahtarın KALANI talebi karşılamıyorsa
 * o tur atlanır. Kapasitesi ondan küçük her sipariş onu yine ilk sırada seçeceği için parça
 * kapasite satılmaya devam eder (ve `expires_at` MAK'ta pratikte NULL'dır).
 *
 * ── İKİNCİ POLİTİKA: `mode:'spread'` (ürün ayarı `one-per-key`) ──
 *
 * Yukarıdaki kural artık VARSAYILANDIR, tek seçenek değil. İşletme bazı ürünlerde tersini
 * ister: her birim AYRI anahtardan (3 birim + 3 uygun anahtar = 3 anahtar × 1 hak). O modda
 * bu fonksiyon TEK bir birim alır (`LEAST(1, kalan)`) ve çağıran, o turda kullandığı
 * anahtarları `exclude` ile dışlayarak bir sonraki anahtara geçer.
 *
 * SIRALAMA SPREAD'DE FEFO/FIFO'YA GERİ DÖNER (boolean ifade YOK). `use_count ASC` ile
 * sıralamak dışlama listesini gereksiz kılardı ama üç bedeli vardı ve reddedildi:
 * (1) FEFO'yu ikinci sıraya düşürürdü — 1 kez kullanılmış ve yarın ölecek anahtar, hiç
 * kullanılmamış süresiz anahtara yenilirdi; (2) siparişler ARASI da dağıtır, parça
 * kapasiteler geç kapanırdı; (3) `use_count`'u indekslemeyi gerektirirdi ve bu, kapasite
 * düşümünün HOT-update'ini öldürürdü (license_items sistemin en sıcak yazma tablosu).
 * Şimdiki hâliyle spread sorgusu `license_items_alloc_idx` ile BİREBİR örtüşür.
 *
 * @param opts.mode 'fill' (varsayılan, eski davranış) | 'spread' (tek birim al)
 * @param opts.exclude Bu turda ZATEN kullanılmış anahtarlar (yalnız spread'de anlamlı)
 * @returns düşülen anahtar + alınan birim; hiç kapasite yoksa null
 */
export async function consumeMultiUseCapacity(
  db: Executor,
  productId: string,
  want: number,
  opts?: { mode?: 'fill' | 'spread'; exclude?: readonly string[] },
): Promise<MultiUseTake | null> {
  if (want <= 0) return null;
  const spread = opts?.mode === 'spread';
  const exclude = spread ? (opts?.exclude ?? []) : [];
  /*
   * `MATERIALIZED` ŞART — tek-kullanımlık yoldaki aşırı teslimat hatasıyla AYNI SINIF.
   * Bu CTE tam bir kez referans ediliyor; planlayıcı onu satır içine alabilir (inline) ve o
   * durumda EvalPlanQual yeniden değerlendirmesinde `LIMIT 1` alt sorgusu TEKRAR koşar.
   * Sonucu burada "tüm stok" değil ama daha sinsi olur: `taken`, GÜNCELLENMİŞ satırdan yeniden
   * hesaplanabilir → tüketilen kapasite ile çağırana dönen birim sayısı AYRIŞIR (müşteriye N
   * birim yazılırken anahtardan M düşer). Sessiz muhasebe hatasıdır.
   *
   * NOT: bu dosyanın üst tarafındaki açıklama bir dönem "MAK yolu zaten doğru deseni kullanıyor"
   * diyordu; kod `MATERIALIZED` DEMİYORDU. Açıklamanın kendisi denetimi yanlış yönlendirdi.
   */
  // Politikaya göre DEĞİŞEN üç parça. Şablonun geri kalanı TEK GÖVDEDİR: iki ayrı sorgu
  // yazmak, `MATERIALIZED` / `SKIP LOCKED` / `depleted` gibi regresyon kalkanlarından birinin
  // yalnız bir dalda unutulmasına açık kapı bırakırdı.
  const takenExpr = spread
    ? // SPREAD: her turda TEK birim. Anahtarın kalanı 0 olamaz (WHERE use_count < max_uses).
      sql`LEAST(1, max_uses - use_count)`
    : sql`LEAST(${want}, max_uses - use_count)`;
  const orderExpr = spread
    ? // Boolean ifade YOK → sıralama `license_items_alloc_idx` ile BİREBİR örtüşür.
      sql`expires_at ASC NULLS LAST, created_at, seq`
    : sql`(max_uses - use_count >= ${want}) DESC, expires_at ASC NULLS LAST, created_at, seq`;
  // Tur içi dışlama: bu satırda ZATEN kullanılmış anahtarlar bir daha seçilmesin.
  // `ANY(${dizi}::uuid[])` drizzle şablonunda BOZUK SQL üretir (proje tuzağı) → parametreli IN.
  const excludeCond =
    false && exclude.length > 0
      ? sql`AND id NOT IN (${sql.join(
          exclude.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``;

  const list = await rawRows<{ id: string; taken: number }>(db, sql`
    WITH picked AS MATERIALIZED (
      -- Alınacak birim TEK anahtarın KALAN kapasitesiyle sınırlıdır: LEAST(istenen, kalan).
      -- Eski sürüm "hepsi ya da hiç" (use_count + want <= max_uses) idi ve çağıran her
      -- BİRİM için ayrı çağrı yapıyordu; artık kalan ne kadarsa o kadar alınır, dolayısıyla
      -- 200 birimlik bir MAK satırı 200 değil ~1 gidiş-dönüşte karşılanır. Dağılım aynı:
      -- FEFO sırasındaki ilk anahtar doldurulur, artan talep sonraki anahtara taşar.
      -- SPREAD modunda ise tavan 1'dir (her birim ayrı anahtardan).
      SELECT id, ${takenExpr} AS taken
      FROM license_items
      WHERE product_id = ${productId}
        AND status = 'available'
        AND use_count < max_uses
        AND ${notExpiredCond()}
        ${excludeCond}
      -- FILL: 1) TALEBİ TEK BAŞINA KARŞILAYAN ANAHTAR ÖNCE (kullanıcı kararı — üstteki blok);
      --    boolean sıralamada true > false olduğu için DESC "karşılayanlar önce" demektir.
      --    2-3) FEFO + FIFO.
      -- SPREAD: yalnız FEFO + FIFO (dışlama listesi turu ilerletir).
      ORDER BY ${orderExpr}
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
  if (!row) return null;
  const taken = Number(row.taken);

  /*
   * FAIL-CLOSED KALKAN (tek-kullanımlık yoldakinin ikizi): `LIMIT 1` + `LEAST(want, kalan)`
   * gereği tek satır ve 1..want arası birim dönmelidir. Aksi hâli sessizce ya aşırı teslimat
   * (müşteri ödemediği aktivasyonu alır) ya da kayıp kapasite demektir; transaction'ı patlatmak
   * ikisinden de İYİDİR. Kalkanın değeri ölçüldü: aynı sınıftaki tek-kullanımlık hata aylarca
   * "testler bazen kırmızı" gürültüsü sanılmıştı — sessiz olduğu için.
   */
  // SPREAD'de tavan `want` DEĞİL 1'dir → kalkan orada DARALIR. Gevşek bıraksaydık
  // `LEAST(1, …)` ifadesi ileride bozulduğunda sessiz aşırı teslimat üretirdi.
  const cap = spread ? 1 : want;
  if (list.length > 1 || !Number.isInteger(taken) || taken < 1 || taken > cap) {
    throw new Error(
      `MAK kapasite invaryantı ihlali (mod ${spread ? 'spread' : 'fill'}): ${want} birim ` +
        `istendi, ${list.length} satır / ${taken} birim döndü (tavan ${cap}, ürün ${productId}). ` +
        'İşlem geri alındı.',
    );
  }
  return { licenseItemId: row.id, taken };
}
