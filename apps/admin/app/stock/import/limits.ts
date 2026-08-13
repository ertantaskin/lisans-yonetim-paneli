/**
 * Stok girişi ekranının boyut/adet tavanları — **TEK KAYNAK**.
 *
 * NEDEN AYRI DOSYA: `app/stock/actions.ts` bir `'use server'` modülüdür ve oradan sabit
 * export EDİLEMEZ (Next 15: "can only export async functions" → tüm action chunk'ı patlar;
 * bu hata bu projede İKİ KEZ üretime çıktı, `scripts/check-use-server.js` artık zorluyor).
 * Bu yüzden sabitler nötr bir modülde durur; hem sunucu action'ı hem istemci formu BURADAN
 * okur → kullanıcıya gösterilen sınır metni ile gerçekte uygulanan sınır asla ayrışmaz.
 */

/**
 * Yapıştırılan/dosyadan okunan girdinin ham üst sınırı (bayt).
 *
 * Kaynağı API tarafındaki Fastify `bodyLimit` 1 MiB'dir (apps/api/src/main.ts) ve Next
 * sunucu action gövdesi de varsayılan 1 MB'tır. Hesap (account) satırı JSON zarfıyla
 * birlikte ~150 bayt tuttuğu için 10.000 satırlık API sınırından ÖNCE gövde sınırına
 * çarpılır → tavan gövdeden türetilir, satır sayısından değil.
 */
export const MAX_IMPORT_BYTES = 700 * 1024;

/**
 * API sözleşmesindeki kayıt tavanı (`ImportBody.items` → `.max(10_000)`).
 * Aşılırsa istek 400 döner; ekran bunu ÖNCEDEN, Türkçe mesajla söyler.
 */
export const MAX_IMPORT_ITEMS = 10_000;

/**
 * Hesap (account) TABLO modunda ekranda tutulan en fazla satır.
 *
 * NEDEN AYRI VE ÇOK DAHA DÜŞÜK: tablo her hücre için bir `<input>` render eder. 10.000
 * satırlık bir Excel bloğu 3 sütunla 30.000 kontrollü input demektir — sekme kilitlenir ve
 * operatör verisini kaybeder. Gövde sınırı bunu ÖNLEMEZ (blokaj ancak render'dan SONRA
 * görünür). Bu yüzden yapıştırma bu tavanda kırpılır ve kalanı için JSON (gelişmiş)
 * sekmesi önerilir — orada girdi tek `<textarea>`dır, sınır yalnız `MAX_IMPORT_ITEMS`tir.
 */
export const MAX_TABLE_ROWS = 500;

/**
 * Bayt sayısını okunur B/KB/MB metnine çevirir (Türkçe ondalık ayracı).
 *
 * 1 KB altı ham BAYT olarak yazılır: `Math.ceil` boş formda bile ("[]" = 2 bayt)
 * "1 KB" gösteriyordu ve sayaç daha ilk açılışta yanlış okunuyordu.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
  if (bytes < 1024) return `${Math.max(Math.round(bytes), 0)} B`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

/** Kullanıcıya gösterilen tavan metni — elle yazılmaz, sabitten TÜRETİLİR. */
export const MAX_IMPORT_LABEL = formatBytes(MAX_IMPORT_BYTES);
