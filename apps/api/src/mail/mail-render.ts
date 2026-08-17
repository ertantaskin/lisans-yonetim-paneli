/**
 * Teslimat mailinin SAF (yan etkisiz) render yardımcıları.
 *
 * NEDEN AYRI DOSYA: bu fonksiyonlar hem gerçek gönderim (MailProcessor) hem önizleme
 * (DeliveryMailBuilder) yolunda kullanılır. Worker dosyasında kalsalardı, önizleme onları
 * import etmek için BullMQ worker sınıfını da yüklemek zorunda kalırdı (ve iki yön arasında
 * döngüsel import doğardı). Saf oldukları için birim testleri de altyapısızdır.
 */

/**
 * Yerel saat dilimi etiketi (ör. `UTC+03:00`) — o ANDAKİ ofset (yaz saati dahil doğru).
 *
 * ICU'ya (`timeZoneName`) BİLEREK dayanmaz: çıktı Node/ICU sürümüne göre "GMT+3" / "+3" gibi
 * değişebilirdi ve bu değer hem maile hem şablon önizlemesine giriyor — iki yüzeyin ayrışmaması
 * için biçim deterministik olmalı.
 */
function localUtcOffsetLabel(d: Date): string {
  const minutes = -d.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

/**
 * Geçerlilik bitişini müşteriye gösterilecek YEREL tarih-SAATE çevirir (§11 süreli hesap).
 *
 * NEDEN SAAT ve SAAT DİLİMİ VAR (ölçülmüş sapma): burası yalnız GÜN yazıyordu ve gün, API
 * konteynerinin saat dilimine göre hesaplanıyordu; müşteri sayfası/.txt ise MAĞAZANIN saat
 * diliminde ve SAATLİ gösteriyordu. İkisini bağlayan hiçbir kod yoktu. Somut sonuç:
 * `valid_until = 2026-08-16T22:30Z` + mağaza UTC ise mail "17.08.2026", sayfa "16.08.2026 22:30"
 * diyordu — süreli hesap müşterisi bir günü olduğunu (ya da olmadığını) sanıyordu. Belirsizlik
 * en kötü seçenektir: hangi dilimde gösterildiği artık METİNDE yazılıdır ve makine-okunur
 * karşılığı `{{valid_until_iso}}` ile ayrıca sunulur.
 *
 * Boş/geçersiz değer → '' (şablon token'ı boş kalır, mail bozulmaz — kritik olmayan bir alan
 * yüzünden teslimat maili ASLA düşmemeli). Saat dilimi konteynerden gelir (docker-compose:
 * TZ=Europe/Istanbul) → panelin gösterdiği gün sınırıyla aynı.
 */
export function formatValidUntil(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  // Saat ELLE biçimlenir: `toLocaleTimeString` bazı ICU sürümlerinde gece yarısını '24:00'
  // yazar ve hour12/hourCycle davranışı sürüme göre değişir — tarih zaten kritik bir alan.
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${date} ${time} (${localUtcOffsetLabel(d)})`;
}

/**
 * Aynı değerin HAM ISO 8601 (UTC) karşılığı — `{{valid_until_iso}}`.
 *
 * Yerel biçim insan içindir ve saat dilimi etiketiyle birlikte okunmalıdır; ISO ise
 * yoruma kapalıdır. Mağazanın kendi yüzeyi (sayfa/.txt) tarihi zaten UTC anlık değerinden
 * üretir → operatör şablonunda ikisini yan yana kullanarak iki yüzeyi birebir eşleyebilir.
 */
export function formatValidUntilIso(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

/** Şablon gövdesinde `{{guides}}` token'ı geçiyor mu (boşluklu yazım da sayılır). */
const GUIDES_TOKEN_RE = /\{\{\s*guides\s*\}\}/;

/**
 * Rehber bloğunu maile YERLEŞTİRİR — şablonda `{{guides}}` yoksa SONA EKLER.
 *
 * NEDEN FALLBACK VAR (sessiz kayıp koruması): rehber özelliği eklendiğinde operatörlerin
 * veritabanında ZATEN kayıtlı şablonları vardır ve hiçbiri bu token'ı içermez. Yalnız
 * token'a güvenilseydi, panelde rehber tanımlayan operatör onun maile girdiğini SANIR ama
 * müşteri hiçbir zaman göremezdi — üstelik hata da alınmazdı. (Şablon editörü ayrıca
 * "desteklenen değişken" listesini gösterir; token'ı bilerek yerleştirmek isteyen operatör
 * konumu kendisi seçebilir, o durumda bu ek çalışmaz.)
 *
 * @param rendered Token'ları değiştirilmiş nihai gövde.
 * @param template Ham şablon (token aranan yer — render sonrası metinde token kalmaz).
 * @param guides   Rehber bloğu; boşsa hiçbir şey eklenmez.
 */
export function withGuides(rendered: string, template: string, guides: string): string {
  if (!guides) return rendered;
  if (GUIDES_TOKEN_RE.test(template)) return rendered;
  return `${rendered.replace(/\s+$/, '')}\n\n${guides}\n`;
}

/**
 * Kalem satırındaki BİRİM etiketi — `• Ürün<etiket>: ANAHTAR` biçiminde ürün adının hemen
 * ardına gelir. Etiket gerekmiyorsa boş string döner.
 *
 * NEDEN VAR (ölçülmüş müşteri şikâyeti): eski kural `units > 1 ? " (N adet)" : ""` idi ve
 * MAK/çok kullanımlık üründe İKİ AYRI YANLIŞ üretiyordu:
 *
 *  1) "adet" kelimesi ANAHTAR SAYISI gibi okunuyordu. Gerçek bir siparişte (dev #69) müşteri
 *     "Windows 11 Pro MAK (5 adet): MAK-AAAA-…" satırını görüyor ve 5 anahtar aldığını
 *     sanıyordu; oysa TEK anahtarı 5 KEZ etkinleştirme hakkı almıştı.
 *  2) `units = 1` olan MAK anahtarında HİÇBİR ŞEY yazmıyordu. Aynı siparişin ikinci satırı
 *     ("… : MAK-FINAL-0001") çıplak bir anahtar gibi görünüyordu — müşteri o anahtarın
 *     tamamen kendisine ait olduğunu, istediği kadar makinede kullanabileceğini sanıyordu.
 *     MAK anahtarı PAYLAŞIMLIDIR: panel yalnız defter tutar, anahtarın kalan kapasitesini
 *     kullanmayı teknik olarak engelleyen bir şey yoktur → "1" bilgisi müşteriye SÖYLENMELİ.
 *
 * Bu yüzden karar `units`e değil ÜRÜNÜN KULLANIM MODUNA bağlıdır: `multi` ise sayı HER ZAMAN
 * yazılır (1 olsa bile), `single` ise hiç yazılmaz (orada units zaten daima 1'dir).
 *
 * `usageMode` bilinmiyorsa (ürün satırı çözülemedi) eski davranışa düşülür — kritik olmayan
 * bir etiket yüzünden teslimat maili biçim değiştirmez.
 */
export function unitLabel(
  units: number,
  usageMode: string | null | undefined,
  productKind: string | null | undefined,
): string {
  if (usageMode === 'multi') {
    // Hesap ürününde "etkinleştirme" yanlış çağrışım yapar (oturum açılır, etkinleştirilmez).
    const noun = productKind === 'account' ? 'kullanım hakkı' : 'etkinleştirme hakkı';
    return ` (bu siparişte ${units} ${noun})`;
  }
  if (usageMode === 'single') return '';
  return units > 1 ? ` (${units} adet)` : '';
}

/** Kalemler arasındaki EN YAKIN (en erken) geçerlilik bitişi; hiç yoksa null. */
export function earliestValidUntil(values: Array<Date | null | undefined>): Date | null {
  let min: Date | null = null;
  for (const v of values) {
    if (!v) continue;
    if (min === null || v.getTime() < min.getTime()) min = v;
  }
  return min;
}
