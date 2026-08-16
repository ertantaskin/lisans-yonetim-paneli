import postgres from 'postgres';

/**
 * ENTEGRASYON PAKETİ — KOŞU ÖNCESİ TAM SIFIRLAMA (globalSetup).
 *
 * NEDEN VAR (ÖLÇÜLDÜ, tahmin değil): paket AYNI veritabanında tekrar tekrar koşmaya karşı
 * idempotent DEĞİLDİ. Üst üste koşumlarda hata sayısı 1→3→8'e çıkıyor, aynı dosya tek başına
 * 9/9 geçiyor, TAZE DB'de tamamı geçiyordu. Yani biriken test verisi KOD REGRESYONU gibi
 * görünüyordu — bu, her gelecekteki doğrulamayı zehirleyen bir kararlılık kusuru.
 *
 * NEDEN "TEMİZLİĞİ GENİŞLETMEK" DEĞİL: kalıntının kaynağı tek bir tablo değil, YAPISAL:
 *  · `cleanupByTag` 12 tabloyu siliyor ama `audit_log` / `security_events` FK taşımadığı için
 *    hiç düşmüyor; `email_log.order_id` ON DELETE SET NULL olduğu için sipariş silinince satır
 *    KALIYOR (CASCADE yanılsaması).
 *  · Bazı testler etiketsiz SABİT payload kullanıyor; `payload_hash` GLOBAL unique ve import
 *    `onConflictDoNothing` ile mükerreri SESSİZCE atlıyor → ikinci koşuda `imported` eksiliyor.
 *  · Penceresiz/GLOBAL raporlarda (maliyet `allTime`, SLA/reorder LIMIT'li) sabit sayı assert'leri
 *    birikmiş satırlarla kayıyor ve hata GERÇEK SEBEBİNDEN uzakta patlıyor.
 * "Kapsamı genişletme" oyunu bu projede DÖRT kez oynandı (site_product_mappings → batches/
 * purchase_orders/suppliers → product_guides → supplier_claims) ve her seferinde BİR SONRAKİ
 * tablo unutuldu. Beşincisi de unutulurdu. Bu yüzden kalıntı imkânsız kılınıyor.
 *
 * NEDEN KOŞUNUN BAŞINDA (sonunda değil): çöken bir koşumun kanıtı incelenebilsin. Sonda
 * temizlemek, arızayı üreten veriyi de silerdi.
 *
 * TABLO LİSTESİ ELLE YAZILMAZ: `information_schema`'dan türetilir → yeni tablo eklendiğinde
 * liste kendiliğinden güncellenir (unutma sınıfı kapanır). `__drizzle_migrations` HARİÇ —
 * migration izleyicisi silinirse sonraki `db:migrate` her şeyi yeniden uygulamaya kalkar.
 */

/** Test veritabanı olduğu KANITLANMADIKÇA hiçbir şey silinmez. */
function assertTestDatabase(url: string): string {
  let dbName: string;
  try {
    // postgres://kullanıcı:parola@host:port/veritabanı?...
    dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error('DATABASE_URL ayrıştırılamadı — entegrasyon paketi başlatılmadı.');
  }
  if (!dbName) throw new Error('DATABASE_URL veritabanı adı içermiyor.');

  // EMNİYET KİLİDİ: bu betik TRUNCATE koşar. Yanlış ayarlanmış bir DATABASE_URL geliştirme ya da
  // ÜRETİM verisini silerdi. Ad bir test kalıbına uymuyorsa koşu BAŞLAMADAN durur (fail-closed).
  const looksLikeTest = /(^|[_-])test([_-]|$)|test$/i.test(dbName);
  if (!looksLikeTest) {
    throw new Error(
      `GÜVENLİK DURDURMASI: '${dbName}' bir test veritabanı adına benzemiyor. Entegrasyon paketi ` +
        'TRUNCATE koşar; yanlış bir DATABASE_URL geliştirme/üretim verisini silerdi. Test DB adı ' +
        "'test' içermeli (ör. lisanspanel_test).",
    );
  }
  return dbName;
}

export async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL tanımlı değil — entegrasyon paketi koşamaz.');
  const dbName = assertTestDatabase(url);

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename <> '__drizzle_migrations'
    `;
    if (rows.length === 0) {
      throw new Error(
        `'${dbName}' içinde tablo yok — migration'lar koşmamış olabilir (db:migrate → test:integration).`,
      );
    }
    // Tek ifade + CASCADE: FK sırası düşünülmez. RESTART IDENTITY — `license_items.seq` gibi
    // sıra kolonları da sıfırlanır (sıralama testleri koşumlar arası kaymasın).
    const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
    await sql.unsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    // eslint-disable-next-line no-console
    console.log(`[entegrasyon] '${dbName}' sıfırlandı: ${rows.length} tablo TRUNCATE edildi.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
