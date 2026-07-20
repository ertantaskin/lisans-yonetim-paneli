import { describe, expect, it } from 'vitest';
import { mask } from './admin-orders.service';

describe('mask (sertleştirilmiş — §8)', () => {
  it('yalnız son 4 haneyi gösterir', () => {
    expect(mask('WIN10-PRO-XYZ12-ABCDE-98765')).toBe('••••••8765');
  });

  it('sabit genişlikli gövde: uzunluk sızmaz', () => {
    // Farklı uzunluktaki iki key aynı gövde uzunluğuyla maskelenir.
    const a = mask('AAAA-BBBB-CCCC-1234');
    const b = mask('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-5678');
    const bodyOf = (s: string) => s.slice(0, -4);
    expect(bodyOf(a)).toBe(bodyOf(b)); // gövde sabit → uzunluk parmak izi yok
    expect(a.endsWith('1234')).toBe(true);
    expect(b.endsWith('5678')).toBe(true);
  });

  it('tire/segment yapısını sızdırmaz (eski maske aksine)', () => {
    const m = mask('WIN10-PRO-XYZ12-ABCDE-98765');
    // Görünür son 4 dışında tire/karakter yapısı görünmemeli.
    expect(m.slice(0, -4)).toBe('••••••');
    expect(m).toBe('••••••8765');
  });

  it('kısa payload tümüyle maskelenir', () => {
    expect(mask('AB')).toBe('••••••');
    expect(mask('ABCD')).toBe('••••••');
  });
});
