/**
 * Sunum alanlarını (ürün adı, SKU) güvenle kırpan tek kaynak.
 *
 * NEDEN VAR — iki ayrı tuzağın kesişimi:
 *
 * 1) **BİRİM UYUŞMAZLIĞI.** WP eklentisi `mb_substr` ile KOD NOKTASI sayar, JS/Zod ise
 *    UTF-16 KOD BİRİMİ sayar. Emoji/astral karakter taşıyan bir ad eklentide "500 sınırının
 *    altında" görünürken panelde 520 birim edebilir. Sınır `.max()` ile REDDEDİLİRSE tek bir
 *    ürün adı yüzünden TÜM katalog snapshot'ı 400 alır ve hiç yazılmaz (operatör boş katalog
 *    görür, tek iz mağazadaki `error_log` — sessiz veri kaybı). Bu yüzden kritik OLMAYAN
 *    sunum alanları reddedilmez, KIRPILIR.
 *
 * 2) **BÖLÜNEN SURROGATE ÇİFTİ.** Düz `s.slice(0, N)` kesim noktası bir surrogate çiftinin
 *    ORTASINA denk gelirse yalnız-surrogate bırakır. Bu geçerli UTF-8'e çevrilemez; Node
 *    onu U+FFFD (`�`) ile değiştirir ve veritabanına adın son karakteri BOZUK yazılır.
 *    ÖLÇÜLDÜ (dev, gerçek istek): `'A' + '🎁'.repeat(260)` → 500. birim `0xD83C` yalnız
 *    surrogate → saklanan ad `…🎁�` oldu (istek yine 200 döndü, yani SESSİZ).
 *    Kesim burada bir birim geri alınarak karakter sınırına hizalanır.
 *
 * Not: hizalama yalnız surrogate ÇİFTİNİ korur; birden çok kod noktasından oluşan kümeleri
 * (ZWJ ile birleşik emoji, bayrak, ten rengi) bölebilir. Bu bilinçli: bunun için Intl.Segmenter
 * gerekir ve sonuç yine geçerli UTF-8'dir — hedef "bozuk bayt üretme", "grafik küme koru" değil.
 */
export function truncateUtf16Safe(value: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (value.length <= maxUnits) return value;
  const code = value.charCodeAt(maxUnits - 1);
  // Kesimin son birimi bir YÜKSEK surrogate ise (0xD800-0xDBFF), eşi kesimin DIŞINDA
  // kalmıştır → o birimi de dışarıda bırak.
  const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  return value.slice(0, isHighSurrogate ? maxUnits - 1 : maxUnits);
}
