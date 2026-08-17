/**
 * Stok girişi ekranının SAF yardımcıları (yapıştırma çözümleme, görünmez karakter tespiti,
 * lira↔kuruş dönüşümü). Ne `'use client'` ne `'use server'` — hem istemci bileşeni hem
 * sunucu action'ı AYNI mantığı kullansın diye nötr modüldür (ör. birim maliyet istemcide
 * canlı toplam için, sunucuda `unitCostCents` üretmek için aynı fonksiyonla çözülür →
 * ekranda "288,00 ₺" yazıp API'ye başka bir sayı gitmesi imkânsız).
 */
import { MAX_USES_CAP, MAX_USES_MIN } from './limits';

/** İstemciden sunucu action'ına taşınan tek kayıt. */
export interface ImportItemInput {
  /** key/code/custom → düz metin; account → alan→değer nesnesi. */
  payload: string | Record<string, string>;
  /**
   * Bu KAYDIN kendi kullanım hakkı (MAK aktivasyon sayısı) — `license_items.max_uses`.
   *
   * NEDEN SATIR BAZINDA: MAK anahtarları tedarikçiden PARTİ PARTİ gelir ve her partinin
   * aktivasyon sayısı farklı olabilir (50'lik lot, 500'lük lot, hatta "5 aktivasyonu kalmış"
   * tek anahtar). Kapasite bugüne kadar YALNIZ ürün ayarındaydı (`products.max_uses`) ve
   * import onu tüm satırlara kopyalıyordu → farklı lotları girmek için ürünü düzenleyip
   * geri almak gerekiyordu (o düzenleme ürünün TÜM gelecek girişlerini de etkiler).
   *
   * YALNIZ çok kullanımlık (`usageMode='multi'`) üründe anlamlıdır; tek kullanımlık üründe
   * 1 dışında bir değer gönderilirse API TÜM isteği 400'ler. Bu yüzden alan yalnız multi
   * üründe DOLDURULUR (arayüz alanı da yalnız orada render eder). Verilmezse ürünün
   * varsayılanı uygulanır — eski davranış birebir korunur.
   */
  maxUses?: number;
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

/**
 * Başlık eşleştirmesi için normalize.
 *
 * İ/I/ı/i DÖRT varyantı TEK harfe indirilir — DB tarafındaki kategori ikiz kilidiyle AYNI
 * kural (migration 0038: `lower(translate(name,'İIı','iii'))`).
 *
 * NEDEN (test yazılırken yakalanan gerçek kusur): eskiden yalnız `toLocaleLowerCase('tr-TR')`
 * vardı ve tr-TR'de ASCII `I` → NOKTASIZ `ı` olur. Yani BÜYÜK harfle yazılmış İngilizce sütun
 * başlıkları eşleşmiyordu: `"EMAIL"` → `"emaıl"` ≠ `"email"`. Sonuç sessiz ve kötüydü —
 * başlık satırı VERİ sanılıp içe aktarılıyordu (kullanıcı adı "EMAIL" olan bir hesap kaydı).
 * Türkçe başlıklar ("E-POSTA") etkilenmiyordu, bu yüzden gözden kaçmıştı.
 */
function norm(v: string): string {
  return v.trim().replace(/[İIı]/g, 'i').toLocaleLowerCase('tr-TR');
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

// ── Kullanım hakkı (MAK kapasitesi) ──────────────────────────────────────────
/**
 * Kullanım hakkı metnini sayıya çevirir (`items[].maxUses`).
 *
 * Kabul edilen biçimler: "500", "1.000", "1 000" (Türkçe binlik ayracı ve boşluk atılır;
 * yapıştırılan Excel hücresi böyle gelir). Ondalık KABUL EDİLMEZ — aktivasyon adedi tam
 * sayıdır ve "1,5" gibi bir değeri 1'e ya da 2'ye yuvarlamak sessiz veri uydurmaktır.
 *
 * AYRAÇ KURALI (SESSİZ 10× HATASINI KAPATIR): nokta/boşluk yalnız ARDINDAN TAM 3 RAKAM
 * geliyorsa binlik ayracıdır. Kural eskiden yoktu — ayraçlar KOŞULSUZ atılıyordu, dolayısıyla
 * sayı biçimli bir Excel hücresinden gelen "500.0" sessizce **5000** oluyordu. Bu, tam da bu
 * özelliğin ÖNLEMEK için yazıldığı sessiz aşırı-satıştır (panel 5.000 hak sanar, anahtar
 * 500'de biter) ve hiçbir katmanda hata üretmez: 5000 geçerli bir tam sayıdır, API kabul eder,
 * onay modalinde yalnız TOPLAM görünür. Artık "500.0" REDDEDİLİR → operatör satırı görür.
 *
 * BOŞ GİRDİ de `null` döner: çağıran "boş" ile "geçersiz" ayrımını KENDİSİ yapmalıdır
 * (boş = varsayılanı uygula, geçersiz = operatöre göster). İkisi burada birleştirilseydi
 * yanlış yazılmış bir kapasite sessizce varsayılana düşerdi.
 */
export function parseMaxUses(raw: string): number | null {
  // cleanHiddenChars: NBSP/sıfır-genişlik → normal boşluk/atılır + uçlar kırpılır. Yapıştırılan
  // hücrelerde bunlar olağandır ve tek başına `Number()` bunlara takılıp NaN üretir.
  const cleaned = cleanHiddenChars(raw);
  // Ya ayraçsız tam sayı, ya da tamamı 3'lük gruplara bölünmüş bir sayı. Karışık/eksik gruplama
  // ("500.0", "1.23", "12.3456") ondalık ya da yazım hatasıdır → sessizce yorumlanmaz.
  const grouped = /^\d{1,3}([.\s]\d{3})+$/.test(cleaned);
  if (!grouped && !/^\d+$/.test(cleaned)) return null;
  const s = grouped ? cleaned.replace(/[.\s]/g, '') : cleaned;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < MAX_USES_MIN || n > MAX_USES_CAP) return null;
  return n;
}

/**
 * "anahtar<AYRAÇ>kapasite" yapıştırmasında BAŞLIK satırını tanımak için ad listesi.
 *
 * `parseGrid` bu diziyi YALNIZ başlık tespiti için kullanır (satırları sütun sayısına göre
 * bölmez, dolgu yapmaz) → gerçek sütun sayısı ikidir, buradaki fazladan girdiler yalnız
 * "Anahtar;Kullanım hakkı" / "key,maxUses" gibi farklı yazımların da başlık sayılmasını
 * sağlar. Aksi halde başlık satırı VERİ sanılıp anahtar olarak içe aktarılırdı.
 */
export const KEY_CAPACITY_HEADER_ALIASES: GridColumn[] = [
  { key: 'key', label: 'Anahtar' },
  { key: 'lisans', label: 'Lisans' },
  { key: 'maxUses', label: 'Kullanım hakkı' },
  { key: 'max_uses', label: 'Kapasite' },
  { key: 'aktivasyon', label: 'Aktivasyon' },
];

/** İki sütunlu anahtar yapıştırmasının tek satırı (boş satırlar da döner — sayım çağıranda). */
export interface KeyCapacityRow {
  /** Kullanıcının EKRANDA gördüğü satır no; başlık satırı atlansa bile KAYMAZ. */
  line: number;
  /** 1. sütun — HAM (kırpılmaz): görünmez karakter tespiti ham değer üzerinde yapılır. */
  key: string;
  /** 2. sütun — ham; boş ise varsayılan kapasite uygulanır. */
  capacityRaw: string;
  /** İkiden fazla sütun geldiyse fazlalık sayısı (sessizce atılmaz, çağıran uyarır). */
  extraCells: number;
}

/**
 * "anahtar<AYRAÇ>kapasite" bloğunu çözümler — İKİNCİ bir CSV çözümleyici YAZILMAZ:
 * ayraç tespiti, tırnaklı hücre kuralları ve başlık atlama `parseGrid` üzerinden gelir.
 *
 * Bu fonksiyon YALNIZ operatör "anahtarların kapasiteleri farklı" kutusunu işaretlediğinde
 * çağrılır. Kutu kapalıyken satır ASLA ayraçtan bölünmez — içinde noktalı virgül/virgül
 * geçen bir anahtar sessizce kırpılıp yarısı teslim edilemez (sessiz çıkarım yok).
 */
export function parseKeyCapacityRows(text: string): {
  rows: KeyCapacityRow[];
  delimiter: Delimiter | null;
  headerSkipped: boolean;
} {
  const grid = parseGrid(text, KEY_CAPACITY_HEADER_ALIASES);
  // parseGrid yalnız BAŞTAKİ başlık satırını ve SONDAKİ boş satırları düşürür → kaynak satır
  // numarası = dizideki sıra + (başlık atlandıysa 1).
  const offset = grid.headerSkipped ? 1 : 0;
  const rows = grid.rows.map((cells, i) => {
    const padded = padRow(cells, 2);
    return {
      line: i + 1 + offset,
      key: padded[0] ?? '',
      capacityRaw: padded[1] ?? '',
      extraCells: Math.max(cells.length - 2, 0),
    };
  });
  return { rows, delimiter: grid.delimiter, headerSkipped: grid.headerSkipped };
}

// ── Para (lira ↔ kuruş) ──────────────────────────────────────────────────────
/**
 * Kullanıcının LİRA olarak girdiği tutarı KURUŞA çevirir (`unitCostCents`).
 *
 * Bu ayrım bu projede gerçek bir risktir: API alanı kuruştur ve eski formda kullanıcı
 * doğrudan kuruş giriyordu — "12" yazan operatör 12,00 ₺ sanıp 0,12 ₺ kaydediyordu.
 * Burada arayüz lira alır, dönüşüm TEK yerde yapılır.
 *
 * Kabul edilen biçimler: "12", "12,5", "12.50", "1.234,56", "1 234,56", "1.234" (bkz. aşağıdaki
 * kural). Geçersiz/negatif giriş → `null` (çağıran hata gösterir; sessizce 0 kaydetmez).
 *
 * YALNIZ NOKTA VARSA (virgül yok): nokta, ardından TAM 3 rakam geliyorsa binlik ayracıdır.
 * Eskiden koşulsuz ONDALIK sayılıyordu → tr-TR yazımıyla "1.234" giren operatör 1234 ₺ sanıp
 * **1,23 ₺** kaydediyordu (1000× eksik maliyet; `unit_cost_cents` her lisansa snapshot'lanır ve
 * maliyet raporu + tedarikçi karnesi bunu okur). Kural belirsizlik yaratmaz: para biriminde
 * ÜÇ ondalık basamak yoktur — "12,50"/"12.50" iki basamaktır ve ondalık kalır.
 *
 * NOT: temizlenen sınıftaki NBSP kaçış diziyle (`\u00a0`) yazılır — ham U+00A0 kaynağa
 * gömülmez (gözle görülmez, düzenlemede sessizce bozulur; yukarıdaki görünmez-karakter
 * bölümüyle aynı kural). Davranış birebir aynıdır.
 */
export function liraToCents(raw: string): number | null {
  const s = raw.replace(/[\s\u00a0₺]/g, '').replace(/[A-Za-zĞÜŞİÖÇğüşıöç]/g, '');
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
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    // Yalnız nokta + tüm gruplar TAM 3 rakam → binlik ayracı ("1.234" = 1234 ₺, "1.234.567").
    // Grup 3 rakam DEĞİLSE ("12.50", "12.5") dokunulmaz: ondalıktır.
    normalized = s.split('.').join('');
  }
  if (!/^\d*\.?\d*$/.test(normalized) || normalized === '.' || normalized === '') return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  // API üst sınırı (`unitCostCents` → .max(2_000_000_000)) ile hizalı.
  if (cents > 2_000_000_000) return null;
  return cents;
}

/** Para birimi → alan içi önek simgesi (bilinmeyen kod → kodun kendisi). */
export function currencySymbol(currency: string): string {
  const map: Record<string, string> = { TRY: '₺', USD: '$', EUR: '€', GBP: '£' };
  return map[(currency || 'TRY').toUpperCase()] ?? (currency || '').toUpperCase();
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

// ── Parti etiketi (otomatik) ─────────────────────────────────────────────────
/**
 * Sıra numarasını harf ekine çevirir: 0→A, 1→B, … 25→Z, 26→AA (Excel sütun deseni).
 * 26'dan sonra ikinci harfe geçer — bir üründe aynı ay içinde 26'dan fazla parti açılırsa
 * etiket çakışmasın.
 */
export function batchLabelSuffix(index: number): string {
  let n = Math.max(0, Math.floor(index));
  let out = '';
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
    if (n < 0) return out;
  }
}

/**
 * Alım tarihinden parti etiketi türetir: `YYYY-MM-DD-<HARF>` (ör. `2026-08-13-A`).
 *
 * NEDEN: etiket eskiden ZORUNLU ve BOŞ başlıyordu — operatör her girişte elle bir ad
 * uydurmak zorundaydı ve alan kırmızı-zorunlu duruyordu.
 *
 * NEDEN GÜN DE VAR: ilk sürüm yalnız ay kullanıyordu (`2026-08-A`) → aynı ayın 3'ünde ve
 * 27'sinde alınan iki parti `A`/`B` diye ayrışıyordu ve etikete bakan operatör hangisinin
 * hangi alıma ait olduğunu ANLAYAMIYORDU (tarihi görmek için parti detayına girmek
 * gerekiyordu). Gün eklenince etiket kendi başına ayırt edici olur; harf yalnız AYNI GÜN
 * içindeki ikinci/üçüncü girişi ayırmaya yarar (A, B, C…).
 *
 * Harf, AYNI ÜRÜNÜN aynı GÜNE ait mevcut partilerinden ilerletilir: `existingLabels`
 * içinde kullanılmayan İLK harf seçilir (boşluk varsa doldurulur, mükerrer üretilmez).
 * Eski ay-bazlı etiketler (`2026-08-A`) farklı bir desendir; çakışmaz, diziyi kaydırmaz.
 *
 * Liste EKSİK olabilir (yalnız AKTİF partiler çekilir; geri çekilmiş partiler görünmez) →
 * öneri kesin değildir; sunucu `labelDuplicate` ile yumuşak uyarı verir, engel değildir.
 *
 * @param receivedAt `<input type="date">` değeri (`YYYY-MM-DD`). Okunamazsa `''` döner
 *   (çağıran mevcut değeri KORUR — sessizce boşaltmaz).
 */
export function autoBatchLabel(receivedAt: string, existingLabels: readonly string[]): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((receivedAt || '').trim());
  if (!m) return '';
  const prefix = `${m[1]}-${m[2]}-${m[3]}`;
  // Yalnız "aynı gün + saf harf eki" biçimindeki etiketler sayılır; operatörün elle yazdığı
  // serbest adlar (ör. "kasım-toptan") diziyi kaydırmaz.
  const used = new Set<string>();
  const re = new RegExp(`^${prefix}-([A-Za-z]+)$`);
  for (const raw of existingLabels) {
    const hit = re.exec((raw || '').trim());
    if (hit) used.add(hit[1].toUpperCase());
  }
  let i = 0;
  while (used.has(batchLabelSuffix(i))) i += 1;
  return `${prefix}-${batchLabelSuffix(i)}`;
}
