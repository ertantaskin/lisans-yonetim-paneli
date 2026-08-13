/**
 * Tedarik (§12) — otomatik oluşturulmuş kayıtların işareti.
 *
 * Bu önek, operatörün ELLE açmadığı; doğrudan stok girişinden OTOMATİK türetilmiş satın
 * alma emirlerinin/partilerin `notes` alanının başına yazılır. Panel bu satırlarda
 * 'Otomatik' rozeti gösterir ve 'Teslim Al' eylemini GİZLER — çünkü mal zaten girilmiştir,
 * ikinci kez teslim almak stoğu şişirirdi.
 *
 * Not: işaret serbest-metin `notes` üzerinden taşınır (şema değişikliği yok).
 */
export const AUTO_RECEIPT_NOTE_PREFIX = '[oto-giris]';

/** `notes` otomatik giriş işareti taşıyor mu? (null/undefined güvenli) */
export const isAutoReceipt = (notes: string | null | undefined): boolean =>
  (notes ?? '').startsWith(AUTO_RECEIPT_NOTE_PREFIX);
