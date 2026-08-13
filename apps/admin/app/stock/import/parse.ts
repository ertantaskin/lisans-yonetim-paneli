/**
 * Stok girişi ekranının SAF yardımcıları (yapıştırma çözümleme, görünmez karakter tespiti,
 * lira↔kuruş dönüşümü). Ne `'use client'` ne `'use server'` — hem istemci bileşeni hem
 * sunucu action'ı AYNI mantığı kullansın diye nötr modüldür (ör. birim maliyet istemcide
 * canlı toplam için, sunucuda `unitCostCents` üretmek için aynı fonksiyonla çözülür →
 * ekranda "288,00 ₺" yazıp API'ye başka bir sayı gitmesi imkânsız).
 */

/** İstemciden sunucu action'ına taşınan tek kayıt. */
export interface ImportItemInput {
  /** key/code/custom → düz metin; account → alan→değer nesnesi. */
  payload: string | Record<string, string>;
  /**
   * Kullanıcının EKRANDA gördüğü kaynak satır numarası (1 tabanlı).
   *
   * NEDEN: API `rejections[].index` değerini gönderilen `items[]` dizisindeki SIRA olarak
   * döndürür; boş satırlar ve (tabloda) başlık satırı atlandığı için bu sıra ekrandaki
   * satır numarasıyla AYNI DEĞİLDİR. Numarayı istemci üretip action'a taşırız → hata
   * raporu doğru satırı işaret eder (eski form `index + 1` gösterip yanlış satırı
   * gösteriyordu).
   */
  line?: number;
}

/** Tablo/CSV çözümlemesinde kullanılan sütun tanımı (ürünün `payloadSchema`'sından gelir). */
export interface GridColumn {
  key: string;
  label: string;
}

const DELIMITERS = ['\t', ';', ','] as const;
export type Delimiter = (typeof DELIMITERS)[number];

/** Ayracın kullanıcıya gösterilen adı ("ayraç: sekme" geri bildirimi). */
export function delimiterLabel(d: Delimiter | null): string {
  if (d === '\t') return 'sekme';
  if (d === ';') return 'noktalı virgül';
  if (d === ',') return 'virgül';
  return 'ayraçsız';
}

/** Metni satırlara böler (CRLF/CR normalize edilir). */
export function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Tek satırı CSV kurallarıyla böler: tırnak içindeki ayraç BÖLMEZ (`"a,b"` tek alan kalır),
 * `""` kaçışı çift tırnak üretir. Excel/Google Sheets kopyaları bu biçimde gelir.
 */
export function splitDelimited(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' && cur.trim() === '') {
      // Alan tırnakla BAŞLIYORSA tırnaklı moda gir (ortadaki tırnak düz karakterdir).
      inQuotes = true;
      cur = '';
      continue;
    }
    if (ch === delim) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Ayracı otomatik seçer: her adayla çözümleyip EN ÇOK SÜTUN üreteni kazanan sayar
 * (eşitlikte sekme > noktalı virgül > virgül — Excel/Sheets kopyası sekmelidir).
 * Hiçbir aday 1'den fazla sütun üretmiyorsa `null` (tek sütunlu yapıştırma).
 */
export function detectDelimiter(lines: string[]): Delimiter | null {
  const sample = lines.filter((l) => l.trim() !== '').slice(0, 50);
  if (sample.length === 0) return null;
  let best: Delimiter | null = null;
  let bestScore = 1;
  for (const d of DELIMITERS) {
    let score = 0;
    for (const line of sample) score = Math.max(score, splitDelimited(line, d).length);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

export interface ParsedGrid {
  /**
   * Çözümlenmiş satırlar — sütun sayısına HİZALANMAZ (dolgu yapılmaz).
   *
   * Neden: yapıştırma her zaman ilk hücreye yapılmaz. 2 sütunluk bir blok 3. sütuna
   * yapıştırılırsa, önden doldurulmuş boş hücreler komşu sütunların mevcut değerlerini
   * SİLERDİ. Hizalamayı yerleştirmeyi yapan taraf (`padRow`) yapar.
   */
  rows: string[][];
  delimiter: Delimiter | null;
  /** İlk satır sütun adlarıyla eşleştiği için BAŞLIK sayılıp atlandı mı. */
  headerSkipped: boolean;
}

/** Satırı hedef sütun sayısına hizalar (eksik → '', fazla → atılır). */
export function padRow(row: string[], width: number): string[] {
  const out = row.slice(0, width);
  while (out.length < width) out.push('');
  return out;
}

/** Türkçe-duyarlı normalize (başlık eşleştirmesi için; "İSİM" ↔ "isim"). */
function norm(v: string): string {
  return v.trim().toLocaleLowerCase('tr-TR');
}

/**
 * Yapıştırılan bloğu tabloya çevirir. Başlık satırı tespiti: ilk satırdaki DOLU hücrelerin
 * hepsi bir sütunun `key` ya da `label` değeriyle eşleşiyorsa o satır veri değil BAŞLIKTIR
 * (aksi halde "kullanici_adi" diye bir hesap girilirdi).
 */
export function parseGrid(text: string, columns: GridColumn[]): ParsedGrid {
  const raw = splitLines(text);
  // Sondaki boş satırlar (kopyalamada hep gelir) atılır; ORTADAKİ boş satır korunur —
  // kullanıcı bilerek boşluk bırakmış olabilir, sayımı "boş satır" olarak raporlanır.
  while (raw.length > 0 && raw[raw.length - 1].trim() === '') raw.pop();
  const delimiter = detectDelimiter(raw);
  let rows = raw.map((line) =>
    delimiter ? splitDelimited(line, delimiter) : [line],
  );

  let headerSkipped = false;
  if (rows.length > 1 && columns.length > 0) {
    const names = new Set<string>();
    for (const c of columns) {
      names.add(norm(c.key));
      names.add(norm(c.label));
    }
    const first = rows[0].filter((c) => c.trim() !== '');
    if (first.length > 0 && first.every((c) => names.has(norm(c)))) {
      rows = rows.slice(1);
      headerSkipped = true;
    }
  }

  return { rows, delimiter, headerSkipped };
}

// ── Görünmez karakterler ─────────────────────────────────────────────────────
// Kopyala-yapıştırın en sinsi hatası: değerin başında/sonunda boşluk ya da NBSP
// (U+00A0) kalması. Teslimattan SONRA "parola çalışmıyor" olarak geri döner; panelde
// gözle ayırt edilemez. Bu yüzden temizlemeyiz (sessiz veri değişikliği yapmayız),
// GÖRÜNÜR İŞARETLERİZ — operatör tek tıkla temizleyebilir.
// Kaçış dizileriyle yazılır (ham karakter kaynağa gömülmez — gözle görülmediği için
// düzenlemede sessizce bozulur): NBSP · dar/figür boşlukları · sıfır-genişlik · BOM.
const SPACE_LIKE = '\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000';
const ZERO_WIDTH = '\u200b-\u200d\u2060\ufeff';
const HIDDEN_CHARS = new RegExp(`[${SPACE_LIKE}${ZERO_WIDTH}]`);

/** Değerde baştaki/sondaki boşluk ya da görünmez karakter var mı. */
export function hasHiddenChars(value: string): boolean {
  if (!value) return false;
  return value !== value.trim() || HIDDEN_CHARS.test(value);
}

/** Görünmez karakterleri normal boşluğa çevirir, sıfır-genişlikleri atar, uçları kırpar. */
export function cleanHiddenChars(value: string): string {
  return value
    .replace(new RegExp(`[${SPACE_LIKE}]`, 'g'), ' ')
    .replace(new RegExp(`[${ZERO_WIDTH}]`, 'g'), '')
    .trim();
}

// ── Para (lira ↔ kuruş) ──────────────────────────────────────────────────────
/**
 * Kullanıcının LİRA olarak girdiği tutarı KURUŞA çevirir (`unitCostCents`).
 *
 * Bu ayrım bu projede gerçek bir risktir: API alanı kuruştur ve eski formda kullanıcı
 * doğrudan kuruş giriyordu — "12" yazan operatör 12,00 ₺ sanıp 0,12 ₺ kaydediyordu.
 * Burada arayüz lira alır, dönüşüm TEK yerde yapılır.
 *
 * Kabul edilen biçimler: "12", "12,5", "12.50", "1.234,56", "1 234,56".
 * Geçersiz/negatif giriş → `null` (çağıran hata gösterir; sessizce 0 kaydetmez).
 */
export function liraToCents(raw: string): number | null {
  const s = raw.replace(/[\s ₺]/g, '').replace(/[A-Za-zĞÜŞİÖÇğüşıöç]/g, '');
  if (!s) return null;
  let normalized = s;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // İkisi de var → SONRAKİ ondalık ayraçtır, öteki binlik ayracıdır.
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousand = decimal === ',' ? '.' : ',';
    normalized = s.split(thousand).join('').replace(decimal, '.');
  } else if (lastComma >= 0) {
    normalized = s.replace(',', '.');
  }
  if (!/^\d*\.?\d*$/.test(normalized) || normalized === '.' || normalized === '') return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  // API üst sınırı (`unitCostCents` → .max(2_000_000_000)) ile hizalı.
  if (cents > 2_000_000_000) return null;
  return cents;
}

/** Kuruşu para birimiyle biçimler (tr-TR). Bilinmeyen kod → sade sayı + kod. */
export function formatMoney(cents: number, currency: string): string {
  const value = cents / 100;
  try {
    return new Intl.NumberFormat('tr-TR', {
      style: 'currency',
      currency: currency || 'TRY',
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} ${currency}`.trim();
  }
}
