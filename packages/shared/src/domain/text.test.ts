import { describe, expect, it } from 'vitest';
import { truncateUtf16Safe } from './text';

/** Bir dizenin geçerli UTF-8'e çevrilebildiğini (yalnız-surrogate içermediğini) doğrular. */
function isWellFormed(s: string): boolean {
  // Node, geçersiz birimleri UTF-8'e çevirirken U+FFFD ile değiştirir → tur bozulur.
  return Buffer.from(s, 'utf8').toString('utf8') === s;
}

describe('truncateUtf16Safe', () => {
  it('sınırın altındaki dizeye dokunmaz', () => {
    expect(truncateUtf16Safe('Windows 11 Pro', 500)).toBe('Windows 11 Pro');
  });

  it('ASCII dizeyi tam sınırda kırpar', () => {
    expect(truncateUtf16Safe('abcdef', 3)).toBe('abc');
  });

  it('surrogate ÇİFTİNİ ortadan bölmez (asıl kusur)', () => {
    // 'A' + emoji'ler: 500. birim bir surrogate çiftinin ORTASINA denk gelir.
    const s = 'A' + '🎁'.repeat(260);
    const cut = truncateUtf16Safe(s, 500);
    expect(cut.length).toBe(499); // bir birim geri alındı
    expect(isWellFormed(cut)).toBe(true);
    // Düz slice ile KARŞILAŞTIR: eski davranış bozuk çıktı üretiyordu.
    expect(isWellFormed(s.slice(0, 500))).toBe(false);
  });

  it('kesim zaten karakter sınırındaysa bir birim KAYBETMEZ', () => {
    const s = '🎁'.repeat(260); // her emoji 2 birim → 500. birim çiftin SONU
    const cut = truncateUtf16Safe(s, 500);
    expect(cut.length).toBe(500);
    expect([...cut]).toHaveLength(250);
    expect(isWellFormed(cut)).toBe(true);
  });

  it('tek bir astral karakter sınırı aşarsa boş döner (yarım karakter bırakmaz)', () => {
    expect(truncateUtf16Safe('🎁', 1)).toBe('');
  });

  it('sıfır/negatif sınırda boş döner', () => {
    expect(truncateUtf16Safe('abc', 0)).toBe('');
    expect(truncateUtf16Safe('abc', -5)).toBe('');
  });

  it('Türkçe karakterler tek birimdir, davranış değişmez', () => {
    expect(truncateUtf16Safe('şğüİıöç', 4)).toBe('şğüİ');
  });
});
