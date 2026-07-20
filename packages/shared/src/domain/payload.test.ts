import { describe, expect, it } from 'vitest';
import {
  AccountPayloadSchema,
  maskAccountFields,
  maskSecret,
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
