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

/** Bayt sayısını okunur KB/MB metnine çevirir (Türkçe ondalık ayracı). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

/** Kullanıcıya gösterilen tavan metni — elle yazılmaz, sabitten TÜRETİLİR. */
export const MAX_IMPORT_LABEL = formatBytes(MAX_IMPORT_BYTES);
