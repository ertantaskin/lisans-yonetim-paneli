/**
 * HANGİ REGRESYONU YAKALAR: stok girişi ekranının SAF çekirdeği — yapıştırma çözümleyici,
 * görünmez karakter tespiti, lira↔kuruş dönüşümü ve otomatik parti etiketi. Buradaki her
 * fonksiyon sessiz veri bozulması üretebilecek sınıfta:
 *
 *  - `liraToCents`: API alanı KURUŞ; eski formda "12" yazan operatör 12,00 ₺ sanıp 0,12 ₺
 *    kaydediyordu. Dönüşüm tek yerde → testi de tek yerde.
 *  - `hasHiddenChars`: NBSP/sıfır-genişlik taşıyan parola gözle ayırt edilemez, teslimattan
 *    SONRA "çalışmıyor" olarak döner; ayrıca `payload_hash`i değiştirip mükerrer kontrolünü
 *    kaçırır. Tespit sessizce kaybolursa kimse fark etmez.
 *  - `parseGrid`: başlık satırı yanlış tespit edilirse "kullanici_adi" diye bir HESAP kaydedilir.
 *  - `autoBatchLabel`: etiket ay-bazlıyken (`2026-08-A`) aynı ayın iki alımı ayırt edilemiyordu;
 *    gün eklendi (`YYYY-AA-GG-<HARF>`). Harfin yalnız AYNI GÜN içinde ilerlemesi burada kilitli.
 *
 * NOT: modül `app/stock/import/parse.ts` içinde yaşıyor ama NÖTR (ne 'use client' ne
 * 'use server') — bu yüzden buradan göreli import edilebiliyor.
 */
import { describe, expect, it } from 'vitest';

import {
  autoBatchLabel,
  batchLabelSuffix,
  cleanHiddenChars,
  currencySymbol,
  delimiterLabel,
  detectDelimiter,
  formatMoney,
  hasHiddenChars,
  liraToCents,
  padRow,
  parseGrid,
  parseMaxUses,
  splitDelimited,
  splitLines,
} from '../app/stock/import/parse';

describe('splitLines', () => {
  it('CRLF/CR normalize eder', () => {
    expect(splitLines('a\r\nb\rc\nd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('tek satır → tek eleman', () => {
    expect(splitLines('abc')).toEqual(['abc']);
  });
});

describe('splitDelimited', () => {
  it('düz ayraçla böler', () => {
    expect(splitDelimited('a\tb\tc', '\t')).toEqual(['a', 'b', 'c']);
  });

  it('tırnak içindeki ayraç BÖLMEZ (Excel kopyası)', () => {
    expect(splitDelimited('"a,b",c', ',')).toEqual(['a,b', 'c']);
  });

  it('"" kaçışı tek çift tırnak üretir', () => {
    expect(splitDelimited('"a""b",c', ',')).toEqual(['a"b', 'c']);
  });

  it('alanın ORTASINDAKİ tırnak düz karakterdir', () => {
    expect(splitDelimited('a"b,c', ',')).toEqual(['a"b', 'c']);
  });

  it('boş alanlar korunur', () => {
    expect(splitDelimited('a,,c', ',')).toEqual(['a', '', 'c']);
  });
});

describe('detectDelimiter', () => {
  it('tek sütunlu yapıştırmada null', () => {
    expect(detectDelimiter(['ABC-123', 'DEF-456'])).toBeNull();
    expect(detectDelimiter([])).toBeNull();
    expect(detectDelimiter(['   ', ''])).toBeNull();
  });

  it('sekmeyi seçer', () => {
    expect(detectDelimiter(['a\tb', 'c\td'])).toBe('\t');
  });

  it('noktalı virgül / virgül', () => {
    expect(detectDelimiter(['a;b'])).toBe(';');
    expect(detectDelimiter(['a,b'])).toBe(',');
  });

  it('eşitlikte sekme > noktalı virgül > virgül', () => {
    // Her aday 2 sütun üretir → sıra kararı verir (Excel/Sheets kopyası sekmelidir).
    expect(detectDelimiter(['a\tb;c,d'])).toBe('\t');
    expect(detectDelimiter(['a;b,c'])).toBe(';');
  });

  it('etiketler Türkçe', () => {
    expect(delimiterLabel('\t')).toBe('sekme');
    expect(delimiterLabel(';')).toBe('noktalı virgül');
    expect(delimiterLabel(',')).toBe('virgül');
    expect(delimiterLabel(null)).toBe('ayraçsız');
  });
});

describe('padRow', () => {
  it('eksik hücre boş dizeyle doldurulur, fazlası atılır', () => {
    expect(padRow(['a'], 3)).toEqual(['a', '', '']);
    expect(padRow(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b']);
  });
});

describe('parseGrid', () => {
  const columns = [
    { key: 'email', label: 'E-posta' },
    { key: 'password', label: 'Parola' },
  ];

  it('başlık satırı (label ile) atlanır', () => {
    const r = parseGrid('E-posta\tParola\na@b.com\t1234', columns);
    expect(r.headerSkipped).toBe(true);
    expect(r.delimiter).toBe('\t');
    expect(r.rows).toEqual([['a@b.com', '1234']]);
  });

  it('başlık satırı (key ile) atlanır', () => {
    const r = parseGrid('email\tpassword\na@b.com\t1234', columns);
    expect(r.headerSkipped).toBe(true);
    expect(r.rows).toEqual([['a@b.com', '1234']]);
  });

  it('Türkçe etiket BÜYÜK HARFLE yazılsa da başlık sayılır (tr-TR katlaması)', () => {
    const r = parseGrid('E-POSTA\tPAROLA\na@b.com\t1234', columns);
    expect(r.headerSkipped).toBe(true);
  });

  /**
   * REGRESYON KİLİDİ (bu test yazılırken bulunan GERÇEK kusur — düzeltildi):
   *
   * `parseGrid`'in başlık eşleştirmesi (`norm`) yalnız `toLocaleLowerCase('tr-TR')`
   * kullanıyordu ve tr-TR kuralında ASCII 'I' NOKTASIZ 'ı' olur → BÜYÜK harfle yazılmış
   * İNGİLİZCE sütun adları ("EMAIL" → "emaıl", "LOGIN", "PIN", "ID") anahtarla EŞLEŞMİYOR,
   * satır başlık sayılmıyor ve VERİ olarak içe aktarılıyordu: kullanıcı adı "EMAIL" olan
   * sahte bir hesap kaydı. Türkçe etiket tarafı ("E-POSTA") etkilenmediği için gözden
   * kaçmıştı. `norm` artık İ/I/ı/i dördünü tek harfe indiriyor (migration 0038 ile aynı kural).
   */
  it('"EMAIL" gibi I içeren BÜYÜK HARF key başlık SAYILIR (veri satırı sanılmaz)', () => {
    const r = parseGrid('EMAIL\tPASSWORD\na@b.com\t1234', columns);
    expect(r.headerSkipped).toBe(true);
    expect(r.rows).toEqual([['a@b.com', '1234']]);
  });

  it('veri satırı başlık SANILMAZ', () => {
    const r = parseGrid('a@b.com\t1234\nc@d.com\t5678', columns);
    expect(r.headerSkipped).toBe(false);
    expect(r.rows).toHaveLength(2);
  });

  it('tek satırlık yapıştırmada başlık tespiti yapılmaz (veri kaybı riski)', () => {
    const r = parseGrid('E-posta\tParola', columns);
    expect(r.headerSkipped).toBe(false);
    expect(r.rows).toEqual([['E-posta', 'Parola']]);
  });

  it('sondaki boş satırlar atılır, ORTADAKİ korunur', () => {
    const r = parseGrid('a\n\nb\n\n\n', []);
    expect(r.rows).toEqual([['a'], [''], ['b']]);
  });

  it('satırlar sütun sayısına HİZALANMAZ (yapıştırma komşu sütunu silmesin)', () => {
    const r = parseGrid('a\tb\nc', columns);
    expect(r.rows).toEqual([['a', 'b'], ['c']]);
  });
});

describe('hasHiddenChars / cleanHiddenChars', () => {
  it('temiz değerde işaret yok', () => {
    expect(hasHiddenChars('ABCD-1234')).toBe(false);
    expect(hasHiddenChars('')).toBe(false);
  });

  it('uçtaki normal boşluk yakalanır', () => {
    expect(hasHiddenChars(' abc')).toBe(true);
    expect(hasHiddenChars('abc ')).toBe(true);
  });

  // Görünmez karakterler KAÇIŞ DİZİSİYLE yazılır (parse.ts ile aynı kural): ham karakter
  // kaynağa gömülürse gözle görülmediği için sonraki düzenlemede sessizce bozulur.
  it('NBSP ve sıfır-genişlik ORTADA olsa bile yakalanır', () => {
    expect(hasHiddenChars('a\u00a0b')).toBe(true);
    expect(hasHiddenChars('AB\u200bCD')).toBe(true);
    expect(hasHiddenChars('\ufeffABC')).toBe(true);
  });

  it('temizleme: boşluk-benzeri → normal boşluk, sıfır-genişlik → atılır, uçlar kırpılır', () => {
    expect(cleanHiddenChars('a\u00a0b')).toBe('a b');
    expect(cleanHiddenChars('AB\u200bCD')).toBe('ABCD');
    expect(cleanHiddenChars('\ufeff ABC \u00a0')).toBe('ABC');
  });

  it('temizlenen değer artık işaretlenmez (döngü kapanır)', () => {
    const dirty = ' AB\u200bC\u00a0D ';
    expect(hasHiddenChars(cleanHiddenChars(dirty))).toBe(false);
  });
});

describe('liraToCents', () => {
  it('tam sayı lira → kuruş', () => {
    expect(liraToCents('12')).toBe(1200);
    expect(liraToCents('0')).toBe(0);
  });

  it('virgüllü ve noktalı ondalık', () => {
    expect(liraToCents('12,5')).toBe(1250);
    expect(liraToCents('12.50')).toBe(1250);
  });

  it('binlik ayracı: son gelen ayraç ONDALIKTIR', () => {
    expect(liraToCents('1.234,56')).toBe(123456);
    expect(liraToCents('1,234.56')).toBe(123456);
    expect(liraToCents('1 234,56')).toBe(123456);
  });

  /**
   * Yalnız nokta varken grup boyutu karar verir. Eskiden nokta KOŞULSUZ ondalıktı → tr-TR
   * yazımıyla "1.234" giren operatör 1234 ₺ sanıp 1,23 ₺ kaydediyordu (1000× eksik maliyet,
   * her lisansa snapshot'lanır). Parada üç ondalık basamak olmadığı için kural belirsiz değil.
   */
  it('yalnız nokta: 3 rakamlı grup BİNLİK, 1-2 rakam ONDALIK', () => {
    expect(liraToCents('1.234')).toBe(123400);
    expect(liraToCents('1.234.567')).toBe(123456700);
    expect(liraToCents('12.50')).toBe(1250);
    expect(liraToCents('12.5')).toBe(1250);
  });

  it('₺ simgesi ve NBSP temizlenir', () => {
    expect(liraToCents('₺12,50')).toBe(1250);
    expect(liraToCents('12,50\u00a0₺')).toBe(1250);
  });

  it('geçersiz/negatif giriş → null (sessizce 0 KAYDEDİLMEZ)', () => {
    expect(liraToCents('')).toBeNull();
    expect(liraToCents('   ')).toBeNull();
    expect(liraToCents('abc')).toBeNull();
    expect(liraToCents('-5')).toBeNull();
    expect(liraToCents('12.5.6')).toBeNull();
    expect(liraToCents(',')).toBeNull();
  });

  it('API üst sınırı (2.000.000.000 kuruş) aşılırsa null', () => {
    expect(liraToCents('20000000')).toBe(2_000_000_000);
    expect(liraToCents('20000000,01')).toBeNull();
  });
});

describe('currencySymbol / formatMoney', () => {
  it('bilinen kodlar simgeye, bilinmeyen kod kendine döner', () => {
    expect(currencySymbol('TRY')).toBe('₺');
    expect(currencySymbol('usd')).toBe('$');
    expect(currencySymbol('EUR')).toBe('€');
    expect(currencySymbol('GBP')).toBe('£');
    expect(currencySymbol('')).toBe('₺'); // boş → varsayılan TRY
    expect(currencySymbol('xyz')).toBe('XYZ');
  });

  it('kuruş → tr-TR biçim (ondalık virgül, iki hane)', () => {
    // Tam dize ICU sürümüne bağlı (simge konumu/boşluk tipi) — anlamı doğrularız.
    const out = formatMoney(1250, 'TRY');
    expect(out).toContain('12,50');
    expect(out).toContain('₺');
  });

  it('geçersiz para birimi kodunda sade sayıya düşer (patlamaz)', () => {
    const out = formatMoney(1250, 'X');
    expect(out).toContain('12,50');
    expect(out).toContain('X');
  });
});

describe('batchLabelSuffix', () => {
  it('Excel sütun deseni', () => {
    expect(batchLabelSuffix(0)).toBe('A');
    expect(batchLabelSuffix(25)).toBe('Z');
    expect(batchLabelSuffix(26)).toBe('AA');
    expect(batchLabelSuffix(27)).toBe('AB');
    expect(batchLabelSuffix(51)).toBe('AZ');
    expect(batchLabelSuffix(52)).toBe('BA');
  });

  it('negatif/ondalık girdi 0 tabanına oturur', () => {
    expect(batchLabelSuffix(-3)).toBe('A');
    expect(batchLabelSuffix(1.9)).toBe('B');
  });
});

describe('autoBatchLabel', () => {
  it('GÜN dâhil: YYYY-AA-GG-<HARF>', () => {
    expect(autoBatchLabel('2026-08-13', [])).toBe('2026-08-13-A');
  });

  it('harf yalnız AYNI GÜN içindeki girişleri ilerletir', () => {
    expect(autoBatchLabel('2026-08-13', ['2026-08-13-A'])).toBe('2026-08-13-B');
    expect(autoBatchLabel('2026-08-13', ['2026-08-13-A', '2026-08-13-B'])).toBe('2026-08-13-C');
    // Başka GÜN diziyi kaydırmaz (ay-bazlı eski davranışın regresyonu)
    expect(autoBatchLabel('2026-08-13', ['2026-08-03-A', '2026-08-27-B'])).toBe('2026-08-13-A');
  });

  it('boşluk varsa doldurur (mükerrer üretmez)', () => {
    expect(autoBatchLabel('2026-08-13', ['2026-08-13-B'])).toBe('2026-08-13-A');
  });

  it('küçük harfli mevcut etiket de sayılır', () => {
    expect(autoBatchLabel('2026-08-13', ['2026-08-13-a'])).toBe('2026-08-13-B');
  });

  it('eski ay-bazlı ve serbest adlar diziyi kaydırmaz', () => {
    expect(autoBatchLabel('2026-08-13', ['2026-08-A', 'kasım-toptan', ''])).toBe('2026-08-13-A');
  });

  it('tam ISO damgası da kabul edilir (önek eşleşmesi)', () => {
    expect(autoBatchLabel('2026-08-13T10:00:00.000Z', [])).toBe('2026-08-13-A');
  });

  it('okunamayan tarih → boş dize (çağıran mevcut değeri KORUR)', () => {
    expect(autoBatchLabel('', [])).toBe('');
    expect(autoBatchLabel('13.08.2026', [])).toBe('');
  });
});

describe('parseMaxUses', () => {
  it('düz tam sayı', () => {
    expect(parseMaxUses('500')).toBe(500);
    expect(parseMaxUses(' 50 ')).toBe(50);
  });

  it('Türkçe binlik ayracı ve boşluk atılır (Excel hücresi)', () => {
    expect(parseMaxUses('1.000')).toBe(1000);
    expect(parseMaxUses('1 000')).toBe(1000);
    expect(parseMaxUses('12.345')).toBe(12345);
  });

  /**
   * SESSİZ 10× HATASI: nokta KOŞULSUZ atılıyordu → sayı biçimli bir Excel hücresinden gelen
   * "500.0" 5000 oluyordu. Bu, özelliğin ÖNLEMEK için yazıldığı sessiz aşırı-satışın ta
   * kendisidir (panel 5.000 hak sanar, anahtar 500'de biter) ve hiçbir yerde hata üretmez.
   * Ayrım kuralı: nokta yalnız ARDINDAN TAM 3 RAKAM geliyorsa binlik ayracıdır.
   */
  it('ondalık nokta REDDEDİLİR (binlik ayracı sanılmaz)', () => {
    expect(parseMaxUses('500.0')).toBeNull();
    expect(parseMaxUses('500.00')).toBeNull();
    expect(parseMaxUses('1.5')).toBeNull();
    expect(parseMaxUses('1.0000')).toBeNull();
  });

  it('ondalık virgül REDDEDİLİR', () => {
    expect(parseMaxUses('1,5')).toBeNull();
    expect(parseMaxUses('500,0')).toBeNull();
  });

  it('boş / geçersiz / sınır dışı → null', () => {
    expect(parseMaxUses('')).toBeNull();
    expect(parseMaxUses('abc')).toBeNull();
    expect(parseMaxUses('-5')).toBeNull();
    expect(parseMaxUses('0')).toBeNull();
    expect(parseMaxUses('100001')).toBeNull();
    expect(parseMaxUses('100000')).toBe(100000);
  });
});
