/**
 * Eklenti paketi (.zip) yükleme tavanı — **TEK KAYNAK**.
 *
 * NEDEN AYRI DOSYA: gerçek sınır `actions.ts` içinde tanımlıydı, kullanıcıya gösterilen
 * ipucu metni ise `publish-form.tsx` içinde ELLE yazılıydı → tavan 5 MB'tan 700 KB'a
 * indirilince form hâlâ "En çok 5 MB." diyordu (yanlış vaat: kullanıcı 3 MB'lık zip
 * seçip reddedilmeyi anlayamıyordu). `actions.ts` bir `'use server'` modülüdür ve
 * ORADAN sabit export EDİLEMEZ (Next 15: "can only export async functions" → tüm action
 * chunk'ı patlar, bkz. commit 9b81c9b). Bu yüzden sabit nötr bir modülde durur; hem
 * sunucu action'ı hem istemci formu BURADAN okur.
 *
 * Sınırın kaynağı: API tarafında Fastify `bodyLimit` 1 MiB'dir (apps/api/src/main.ts);
 * zip base64'e çevrilince ~%34 şişer (4/3) ve üstüne JSON zarfı + changelog aynı gövdeye
 * girer → ham zip için güvenli tavan ~700 KB. Eklenti paketi ~100 KB olduğundan bolca yeter.
 */

/** Ham .zip için üst sınır (bayt). Değiştirilecek TEK yer burasıdır. */
export const MAX_ZIP_BYTES = 700 * 1024;

/** Bayt sayısını kullanıcıya okunur KB/MB metnine çevirir (Türkçe ondalık ayracı). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

/**
 * Kullanıcıya gösterilen tavan metni. Elle yazılmaz — sabitten TÜRETİLİR ki
 * `MAX_ZIP_BYTES` değişince form ipucu ve hata mesajı otomatik güncellensin.
 */
export const MAX_ZIP_LABEL = formatBytes(MAX_ZIP_BYTES);
