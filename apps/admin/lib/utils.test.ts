/**
 * HANGİ REGRESYONU YAKALAR: `includesTr` bu projede İKİ KEZ **sessiz boş sonuç** üretti —
 * (1) operatör "ANAHTARI" yazınca "Anahtarı" kaydı bulunamıyordu (ham `toLowerCase()`
 * Türkçe'yi bilmiyor), (2) tr-TR katlamasına geçilince ASCII 'I' noktasız 'ı' olduğu için
 * Ctrl+K'da "ai" → "AI Operasyon" bulunamıyordu. İkisinde de hata YOK, yalnız boş liste var;
 * bu yüzden gözle fark edilmiyor. Fonksiyonun ~15 çağıranı olduğu için davranışı burada
 * MATRİS hâlinde kilitleniyor: iki geçişli (tr-TR + nötr) katlamanın hangi çiftleri
 * eşleştirdiği, hangilerini eşleştirMEDİĞİ dâhil.
 *
 * NOT: testler GERÇEK davranışı kilitler (ölçülerek yazıldı), ideal davranışı değil —
 * matristeki `false` hücreleri bilinçli sınırlardır, bkz. aşağıdaki açıklama.
 */
import { describe, expect, it } from 'vitest';

import { includesTr, lowerTr } from './utils';

describe('lowerTr', () => {
  it('tr-TR kurallarıyla katlar: İ→i, I→ı (varsayılan toLowerCase bunu yapmaz)', () => {
    expect(lowerTr('İIıi')).toBe('iııi');
    expect(lowerTr('IŞIK')).toBe('ışık');
    expect(lowerTr('İSTANBUL')).toBe('istanbul');
  });

  it('Ş/Ğ/Ç/Ö/Ü katlaması', () => {
    expect(lowerTr('ŞEKER GÜÇLÜ ÖZÇÖP')).toBe('şeker güçlü özçöp');
  });

  it('null/undefined → boş dize (çağıran zincirinde patlamaz)', () => {
    expect(lowerTr(null)).toBe('');
    expect(lowerTr(undefined)).toBe('');
  });

  it('dize olmayan girdi String()e çevrilir', () => {
    expect(lowerTr(123)).toBe('123');
  });
});

describe('includesTr — I/İ/ı/i matrisi', () => {
  /**
   * DÖRT VARYANTIN TAM MATRİSİ — hepsi birbirini bulur.
   *
   * TARİHÇE (bu test yazılırken ölçüldü): iki geçişli sürümde 16 hücrenin 5'i `false` idi
   * (`I⊃İ`, `İ⊃ı`, `ı⊃İ`, `ı⊃i`, `i⊃ı`) çünkü tr-TR geçişi I→ı, nötr geçiş ise İ→"i+nokta"
   * üretiyor ve 'ı' ile 'i' her iki katlamada da ayrı kalıyordu. Pratik sonucu ağırdı:
   * **"isik" yazan operatör "IŞIK" kaydını bulamıyordu** — klavyede noktasız 'ı' üretmek
   * zahmetli olduğu için operatör doğal olarak 'i' yazar.
   *
   * ÜÇÜNCÜ GEÇİŞ (nokta katlaması: İ/I/ı/i → i) eklendi; kural veritabanındaki kategori
   * ikiz kilidiyle AYNI (migration 0038 `lower(translate(name,'İIı','iii'))`) — arama ile
   * benzersizlik aynı dili konuşur. Yön güvenli: yalnız daha ÇOK sonuç döner.
   */
  const VARIANTS = ['I', 'İ', 'ı', 'i'] as const;
  const EXPECTED: Record<string, Record<string, boolean>> = {
    I: { I: true, İ: true, ı: true, i: true },
    İ: { I: true, İ: true, ı: true, i: true },
    ı: { I: true, İ: true, ı: true, i: true },
    i: { I: true, İ: true, ı: true, i: true },
  };

  for (const hay of VARIANTS) {
    for (const needle of VARIANTS) {
      const want = EXPECTED[hay][needle];
      it(`haystack "${hay}" ⊃ needle "${needle}" → ${want}`, () => {
        expect(includesTr(hay, needle)).toBe(want);
      });
    }
  }
});

describe('includesTr — yaşanmış regresyonlar', () => {
  it('"ANAHTARI" sorgusu "Anahtarı" kaydını BULUR (1. sessiz-boş-liste vakası)', () => {
    expect(includesTr('Anahtarı', 'ANAHTARI')).toBe(true);
    // ters yön de tutmalı (operatör küçük yazıp kayıt büyük olabilir)
    expect(includesTr('ANAHTARI', 'anahtarı')).toBe(true);
  });

  it('ASCII büyük I: "LISANS" sorgusu "lisansları" içinde bulunur (nötr geçiş)', () => {
    expect(includesTr('lisansları', 'LISANS')).toBe(true);
  });

  it('"ai" sorgusu "AI Operasyon" kaydını BULUR (2. sessiz-boş-liste vakası, Ctrl+K)', () => {
    expect(includesTr('AI Operasyon', 'ai')).toBe(true);
    expect(includesTr('IBAN numarası', 'iban')).toBe(true);
  });

  it('Türkçe kayıtlar nötr katlamayla kaybolmaz (tr-TR geçişi)', () => {
    expect(includesTr('IŞIK Bilişim', 'ışık')).toBe(true);
    expect(includesTr('İhsan Yılmaz', 'ihsan')).toBe(true);
  });

  it('Ş/Ğ/Ç/Ö/Ü her iki yönde eşleşir', () => {
    const upper = 'ŞEKER GÜÇLÜ ÖZÇÖP';
    const lower = 'şeker güçlü özçöp';
    for (const q of ['şeker', 'güçlü', 'özçöp']) expect(includesTr(upper, q)).toBe(true);
    for (const q of ['ŞEKER', 'GÜÇLÜ', 'ÖZÇÖP']) expect(includesTr(lower, q)).toBe(true);
  });
});

describe('includesTr — kenar durumlar', () => {
  it('boş/boşluklu/null sorgu → true (süzme yok, tüm liste görünür)', () => {
    expect(includesTr('abc', '')).toBe(true);
    expect(includesTr('abc', '   ')).toBe(true);
    expect(includesTr('abc', null)).toBe(true);
    expect(includesTr('abc', undefined)).toBe(true);
    // haystack da yokken bile: boş sorgu her şeyi geçirir
    expect(includesTr(null, '')).toBe(true);
  });

  it('null/undefined haystack + dolu sorgu → false (patlamaz)', () => {
    expect(includesTr(null, 'x')).toBe(false);
    expect(includesTr(undefined, 'x')).toBe(false);
  });

  it('sorgunun uçları kırpılır, haystack KIRPILMAZ', () => {
    expect(includesTr('abc', '  b  ')).toBe(true);
    // haystack'teki boşluk korunur → boşluklu arama boşluklu kayda düşer
    expect(includesTr(' abc ', ' abc ')).toBe(true);
  });

  it('dize olmayan girdiler String()e çevrilir', () => {
    expect(includesTr(123, '2')).toBe(true);
    expect(includesTr('abc', 2)).toBe(false);
  });

  it('eşleşmeyen sorgu false döner (matris gevşemesi her şeyi eşleştirmiyor)', () => {
    expect(includesTr('Windows lisansları', 'office')).toBe(false);
  });
});
