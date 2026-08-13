import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Koşullu class birleştirme + Tailwind çakışma çözümü (shadcn deseni). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Türkçe-duyarlı küçültme (tr-TR) — arama/filtre karşılaştırmalarının TEK kaynağı.
 *
 * NEDEN: JS'in varsayılan `toLowerCase()`'i Türkçe'yi bilmez. "İ" harfini `i` + birleşen
 * nokta (U+0307) çiftine indirir, "I"yı da `i` yapar. Sonuç: operatör "ihsan" yazınca
 * "İhsan" kaydı, "ışık" yazınca "IŞIK" kaydı BULUNAMAZ — üstelik sessizce (boş liste,
 * hata yok). `toLocaleLowerCase('tr-TR')` doğru eşleri üretir: "İ"→"i", "I"→"ı".
 *
 * KULLANIM: karşılaştırmanın HER İKİ tarafına da uygulanmalıdır (yalnız hedefe
 * uygulanırsa sorgudaki büyük harf yine tutmaz) — `includesTr` bunu garanti eder.
 */
export function lowerTr(value: unknown): string {
  return value == null ? '' : String(value).toLocaleLowerCase('tr-TR');
}

/**
 * Türkçe-duyarlı "içeriyor mu" — tablo arama/filtre (`filterFn`) fonksiyonlarında kullanılır.
 * TanStack'in yerleşik `includesString` süzgeci ham `toLowerCase()` kullandığı için
 * TÜRKÇE KAYITLARDA BOZUKTUR; onun yerine bu yardımcı çağrılır.
 *
 * İKİ GEÇİŞ (tr-TR **VE** nötr) — neden tek katlama YETMEZ: Türkçe kuralında ASCII `I`
 * NOKTASIZ `ı` olur. Panel içeriği karışıktır; İngilizce kısaltmalar (AI, ID, IBAN, SKU-ID…)
 * tr-TR katlamasıyla `aı`/`ıd`/`ıban` olur ve operatör doğal biçimde "ai"/"id" yazınca
 * EŞLEŞMEZ — üstelik sessizce (hata yok, boş liste; Ctrl+K'da "AI Operasyon" bulunamıyordu).
 * Ters yön de doğrudur: yalnız nötr katlama "IŞIK"/"İhsan" gibi Türkçe kayıtları kaçırır.
 * Bu yüzden her iki katlama denenir, HERHANGİ BİRİ tutarsa eşleşme kabul edilir.
 *
 * Gevşeme bilinçlidir: iki geçiş birkaç fazladan eşleşme üretebilir (ör. "işik" → "IŞIK"),
 * ama bu bir SÜZGEÇ — fazladan satır görmek, aranan kaydı sessizce kaybetmekten iyidir.
 *
 * NOT: `lowerTr` sıralama/karşılaştırma için de kullanılıyor; davranışı DEĞİŞMEDİ.
 */
export function includesTr(haystack: unknown, needle: unknown): boolean {
  const rawNeedle = (needle == null ? '' : String(needle)).trim();
  if (!rawNeedle) return true; // boş sorgu = süzme yok
  const rawHay = haystack == null ? '' : String(haystack);
  // 1) Türkçe katlama: "IŞIK Bilişim" ⊃ "ışık", "İhsan" ⊃ "ihsan"
  if (lowerTr(rawHay).includes(lowerTr(rawNeedle))) return true;
  // 2) Nötr katlama: "AI Operasyon" ⊃ "ai", "IBAN" ⊃ "iban" (tr-TR'de 'aı'/'ıban' olurdu)
  return rawHay.toLowerCase().includes(rawNeedle.toLowerCase());
}

/** ISO tarihi tr-TR biçimler. */
export function formatDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('tr-TR', {
    dateStyle: 'short',
    ...(withTime ? { timeStyle: 'short' } : {}),
  });
}

/**
 * ISO zaman damgasını SABİT timezone (Europe/Istanbul) ile biçimler.
 * İstemci tablo hücrelerinde kullanılır: SSR (UTC) ile istemci (yerel) çıktısı
 * aynı olur → hydration mismatch olmaz. timeZone belirtmeyen toLocale* yerine bunu kullan.
 */
export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Istanbul',
  });
}

/** valid_until geçmiş mi. */
export function isExpired(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}

/** Göreli süre ("3 sa", "2 gün") — bekleme süresi gösterimi (§17). */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - d) / 1000));
  if (s < 60) return 'az önce';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} sa`;
  const days = Math.floor(h / 24);
  return `${days} gün`;
}

/** Bekleme süresine göre renk tonu (yeni→ok, yaşlanıyor→amber, eski→kırmızı). */
export function waitTone(iso: string | null | undefined): 'success' | 'warning' | 'danger' | 'muted' {
  if (!iso) return 'muted';
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 2) return 'success';
  if (h < 24) return 'warning';
  return 'danger';
}
