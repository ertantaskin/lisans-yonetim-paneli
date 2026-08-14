/**
 * Postgres hata kodunu (SQLSTATE) hata zincirinden çıkarır — TEK KAYNAK.
 *
 * NEDEN VAR (gerçek regresyon, entegrasyon testi yakaladı): drizzle-orm 0.45 sürücü
 * hatalarını `DrizzleQueryError` içine SARAR ve orijinal hatayı `cause` zincirine koyar.
 * Kod tabanı ise iki ayrı kırılgan desen kullanıyordu:
 *   (a) `(e as {code?: string}).code === '23505'`      → sarmalayıcıda `code` YOK
 *   (b) `String(e).includes('23505') || …'unique'…`    → sarmalayıcının metni "Failed query: …"
 * İkisi de sürüm yükseltmesiyle SESSİZCE devre dışı kaldı: "bu ad zaten var" (409) demesi
 * gereken yollar ham 500 dönmeye başladı (kategori ikizi, admin e-posta/kullanıcı adı,
 * site-ürün eşlemesi). Kırılma tipte GÖRÜNMEZ — yalnız davranış testi yakalar.
 *
 * Bu yüzden kod okuma TEK yerde ve zinciri gezerek yapılır; sürücü/ORM sarmalaması
 * değişirse yalnız burası güncellenir.
 */

/** Hata zincirinde en fazla bu kadar `cause` derinliğine bakılır (döngü koruması). */
const MAX_CAUSE_DEPTH = 5;

/** SQLSTATE kodunu döndürür; bulunamazsa null. */
export function pgErrorCode(err: unknown): string | null {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < MAX_CAUSE_DEPTH; depth += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * unique_violation (23505) mi?
 *
 * Metin yedeği BİLEREK korunur: SQLSTATE okunamayan bir sarmalama biçimi çıkarsa
 * (ör. ileride başka bir ORM katmanı) davranış sessizce 500'e düşmesin. Yedek yalnız
 * kod bulunamadığında devreye girer, yani yanlış-pozitif üretmez.
 */
export function isUniqueViolation(err: unknown): boolean {
  const code = pgErrorCode(err);
  if (code) return code === '23505';
  const text = String(err).toLowerCase();
  return text.includes('23505') || text.includes('unique constraint');
}

/** foreign_key_violation (23503) mi? */
export function isForeignKeyViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23503';
}
