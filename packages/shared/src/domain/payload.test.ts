import { describe, expect, it } from 'vitest';
import {
  AccountPayloadSchema,
  maskAccountFields,
  maskSecret,
  normalizeFieldValue,
  parseAccountPayload,
  serializeAccountPayload,
} from './payload';

const schema = AccountPayloadSchema.parse([
  { key: 'username', label: 'Kullanıcı', secret: false, required: true },
  { key: 'password', label: 'Parola', secret: true, required: true },
  { key: 'note', label: 'Not', secret: false, required: false },
]);

describe('AccountPayloadSchema', () => {
  it('varsayılan secret/required uygular', () => {
    const s = AccountPayloadSchema.parse([{ key: 'u', label: 'U' }]);
    expect(s[0]).toMatchObject({ secret: false, required: true });
  });

  it('benzersiz olmayan anahtarları reddeder', () => {
    const r = AccountPayloadSchema.safeParse([
      { key: 'u', label: 'A' },
      { key: 'u', label: 'B' },
    ]);
    expect(r.success).toBe(false);
  });

  it('geçersiz key adını reddeder', () => {
    expect(AccountPayloadSchema.safeParse([{ key: '1x', label: 'X' }]).success).toBe(false);
  });
});

describe('normalizeFieldValue', () => {
  it('sondaki/baştaki boşluğu kırpar', () => {
    expect(normalizeFieldValue('  hunter2  ')).toBe('hunter2');
    expect(normalizeFieldValue('\thunter2\n')).toBe('hunter2');
  });

  it('kırılmaz/figür/dar boşlukları normal boşluğa çevirir', () => {
    expect(normalizeFieldValue('a\u00A0b')).toBe('a b');
    expect(normalizeFieldValue('a\u2007b')).toBe('a b');
    expect(normalizeFieldValue('a\u202Fb')).toBe('a b');
    // Kenardaki NBSP: boşluğa dönüp kırpılır (Excel hücresinden en sık gelen hasar).
    expect(normalizeFieldValue('\u00A0hunter2\u00A0')).toBe('hunter2');
  });

  it('baştaki BOM karakterini siler', () => {
    expect(normalizeFieldValue('\uFEFFhunter2')).toBe('hunter2');
  });

  it('akıllı tırnakları düz tırnağa çevirir', () => {
    expect(normalizeFieldValue('\u2018a\u2019')).toBe("'a'");
    expect(normalizeFieldValue('\u201Ca\u201D')).toBe('"a"');
  });

  it('sıfır-genişlik karakterleri siler', () => {
    expect(normalizeFieldValue('hun\u200Bter\u200C2\u200D')).toBe('hunter2');
  });

  it('NFC birleştirir (aynı görünen iki dizi tek gösterime iner)', () => {
    // 'é' tek kod noktası (U+00E9) vs 'e' + birleşen aksan (U+0301).
    expect(normalizeFieldValue('e\u0301')).toBe(normalizeFieldValue('é'));
  });

  it('null/undefined güvenli', () => {
    expect(normalizeFieldValue(null)).toBe('');
    expect(normalizeFieldValue(undefined)).toBe('');
  });
});

describe('serializeAccountPayload', () => {
  it('kanonik JSON üretir (anahtar sırası girdiden bağımsız → dedupe stabil)', () => {
    const a = serializeAccountPayload(schema, { password: 'p', username: 'u' });
    const b = serializeAccountPayload(schema, { username: 'u', password: 'p' });
    expect(a).toBe(b);
    expect(a).toBe('{"password":"p","username":"u"}');
  });

  it('opsiyonel boş alanı atlar', () => {
    const s = serializeAccountPayload(schema, { username: 'u', password: 'p', note: '' });
    expect(s).not.toContain('note');
  });

  it('zorunlu alan boşsa hata verir', () => {
    expect(() => serializeAccountPayload(schema, { username: '', password: 'p' })).toThrow();
    expect(() => serializeAccountPayload(schema, { username: 'u' })).toThrow(); // password eksik
  });

  it('nesne olmayan girdiyi reddeder', () => {
    expect(() => serializeAccountPayload(schema, 'düz-string')).toThrow();
    expect(() => serializeAccountPayload(schema, ['a'])).toThrow();
  });

  it('hiç dolu alan yoksa reddeder (boş {} teslim edilmez)', () => {
    const optionalSchema = AccountPayloadSchema.parse([
      { key: 'a', label: 'A', required: false },
      { key: 'b', label: 'B', required: false },
    ]);
    expect(() => serializeAccountPayload(optionalSchema, { a: '', b: '' })).toThrow(/boş/);
    expect(() => serializeAccountPayload(optionalSchema, {})).toThrow(/boş/);
  });

  // ── Değer normalizasyonu (GÜVENLİK: yanlış parola teslimi + hash sapması) ──

  it('değerleri normalize eder (görünmez karakter saklanmaz)', () => {
    const s = serializeAccountPayload(schema, {
      username: '  jane  ',
      password: '\uFEFFhun\u200Bter2 ',
    });
    expect(JSON.parse(s)).toEqual({ username: 'jane', password: 'hunter2' });
  });

  it('normalize sonrası eşdeğer iki girdi AYNI kanonik JSON üretir (dedupe çalışır)', () => {
    // Aynı hesap: biri elle yazılmış, biri Excel'den yapıştırılmış (NBSP + BOM + sondaki boşluk).
    const temiz = serializeAccountPayload(schema, { username: 'jane', password: "a'b" });
    const yapistirma = serializeAccountPayload(schema, {
      username: '\uFEFFjane ',
      password: ' a\u2019b\u200B ',
    });
    expect(yapistirma).toBe(temiz);
  });

  it('yalnız boşluktan ibaret zorunlu alanı reddeder (NBSP/sıfır-genişlik dâhil)', () => {
    expect(() => serializeAccountPayload(schema, { username: '   ', password: 'p' })).toThrow(
      /Zorunlu alan boş/,
    );
    expect(() => serializeAccountPayload(schema, { username: ' ', password: 'p' })).toThrow(
      /Zorunlu alan boş/,
    );
    expect(() => serializeAccountPayload(schema, { username: '\u200B', password: 'p' })).toThrow(
      /Zorunlu alan boş/,
    );
  });

  // ── Bilinmeyen anahtar (sessiz düşürme = parolasız hesap teslimi) ──

  it('şemada olmayan anahtarı reddeder (sessizce atmaz)', () => {
    expect(() =>
      serializeAccountPayload(schema, { username: 'u', password: 'p', Password: 'P' }),
    ).toThrow(/Şemada olmayan alan: Password/);
  });

  it('hata mesajı anahtar adını verir ama DEĞERİ ASLA içermez', () => {
    let message = '';
    try {
      serializeAccountPayload(schema, { username: 'u', password: 'p', Password: 'cok-gizli-parola' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('Password');
    expect(message).not.toContain('cok-gizli-parola');
  });

  it('birden fazla bilinmeyen anahtarı virgülle birleştirir, en fazla 5 tane sayar', () => {
    const input: Record<string, string> = { username: 'u', password: 'p' };
    for (let i = 1; i <= 7; i++) input[`fazla${i}`] = 'v';
    let message = '';
    try {
      serializeAccountPayload(schema, input);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('fazla1, fazla2, fazla3, fazla4, fazla5');
    expect(message).not.toContain('fazla6');
    expect(message).toContain('+2 daha');
  });

  it('şemada olmayan anahtar BOŞ değerle gelse de reddedilir (anahtar fazlalığı)', () => {
    expect(() =>
      serializeAccountPayload(schema, { username: 'u', password: 'p', totp: '' }),
    ).toThrow(/Şemada olmayan alan: totp/);
  });
});

describe('parseAccountPayload', () => {
  it('şema sırasına göre alanları çözer', () => {
    const serialized = serializeAccountPayload(schema, { username: 'jane', password: 'hunter2' });
    const fields = parseAccountPayload(schema, serialized);
    expect(fields.map((f) => f.key)).toEqual(['username', 'password']);
    expect(fields[1]).toMatchObject({ label: 'Parola', value: 'hunter2', secret: true });
  });

  it('bozuk/JSON olmayan kaydı tek alanlık geriye dönük görünüme çevirir', () => {
    const fields = parseAccountPayload(schema, 'ESKI-DUZ-KEY');
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ key: 'payload', value: 'ESKI-DUZ-KEY' });
  });
});

describe('maskSecret / maskAccountFields', () => {
  it('sabit gövde + son 4 hane', () => {
    expect(maskSecret('ABCDEFGH')).toBe('••••••EFGH');
    expect(maskSecret('AB')).toBe('••••••');
  });

  it('secret alanları KUYRUKSUZ maskeler (parola son-4 sızmaz); açık alanlar korunur', () => {
    const fields = parseAccountPayload(schema, serializeAccountPayload(schema, {
      username: 'jane',
      password: 'hunter2',
    }));
    const masked = maskAccountFields(fields);
    expect(masked.find((f) => f.key === 'username')!.value).toBe('jane'); // açık
    // Parola: sabit gövde, son 4 hane GÖRÜNMEZ (key kimlik maskesinden farklı).
    expect(masked.find((f) => f.key === 'password')!.value).toBe('••••••');
  });
});
