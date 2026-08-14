import { describe, expect, it } from 'vitest';
import { serializeAccountPayload } from '@lisans/shared';
import { mask, maskPayload } from './admin-orders.service';

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

/**
 * REGRESYON (denetim O10): HESAP payload'ı ASLA düz `mask()`/`maskSecret()`ten geçmemeli.
 *
 * `serializeAccountPayload` anahtarları ALFABETİK sıralar → çoğu şemada (ör. {kullanici,
 * sifre} / {email, password}) kanonik JSON düz PAROLAYLA biter. `mask()` son 4 karakteri
 * KORUDUĞU için sonuç `••••••23"}` olur, yani parolanın son iki karakteri sızar; oysa
 * kural payload.ts'te yazılı: secret alanlar KUYRUKSUZ tam maske.
 */
describe('maskPayload (hesap payload maskesi — O10)', () => {
  const schema = [
    { key: 'kullanici', label: 'Kullanıcı', secret: false, required: true },
    { key: 'sifre', label: 'Parola', secret: true, required: true },
  ];

  it('hesap payload maskesi parolanın KUYRUĞUNU sızdırmaz', () => {
    const plain = serializeAccountPayload(schema, { kullanici: 'jane', sifre: 'hunter23' });
    // Ön koşul: kanonik JSON gerçekten parolayla bitiyor (alfabetik sıra: kullanici < sifre).
    expect(plain.endsWith('hunter23"}')).toBe(true);
    // Düz maske bu kuyruğu bırakırdı — kanıt (yanlış davranışın ne ürettiği).
    expect(mask(plain)).toContain('23');

    const masked = maskPayload(plain, 'account', schema);
    expect(masked.maskedPayload).not.toContain('hunter23');
    expect(masked.maskedPayload).not.toContain('23"}');
    // Alan-alan: gizli olmayan kullanıcı adı açık, parola kuyruksuz tam maske.
    expect(masked.maskedFields?.find((f) => f.key === 'kullanici')?.value).toBe('jane');
    expect(masked.maskedFields?.find((f) => f.key === 'sifre')?.value).toBe('••••••');
  });

  it('key/code/custom davranışı birebir korunur (son-4 kimlik maskesi)', () => {
    const masked = maskPayload('WIN10-PRO-XYZ12-ABCDE-98765', 'key', null);
    expect(masked.maskedPayload).toBe('••••••8765');
    expect(masked.maskedFields).toBeNull();
  });

  it('şeması BOZUK hesap ürününde de kuyruk sızmaz (fallback secret sayılır — Y1)', () => {
    // Şema çözülemeyince maskPayload düz maskeye düşer; bu yolun tek koruması Y1'dir
    // (parseAccountPayload fallback'i secret:true) → burada `payload` alanı zaten
    // detail()'de null döner. Yine de düz maskenin ne ürettiğini kayıt altına alıyoruz.
    const masked = maskPayload('{"sifre":"hunter23"}', 'account', { bozuk: true });
    expect(masked.maskedFields).toBeNull();
    expect(masked.maskedPayload.startsWith('••••••')).toBe(true);
  });
});
