import { describe, expect, it } from 'vitest';
import {
  TOTP_STEP_SEC,
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  hotp,
  normalizeTotpCode,
  totpCodeForStep,
  totpReplayTtlSec,
  totpStep,
  verifyTotp,
  verifyTotpOnce,
} from './totp';

/**
 * BİRİM — TOTP çekirdeği (RFC 6238 / RFC 4226 / RFC 4648). DB, Redis, Nest GEREKTİRMEZ.
 *
 * Kapsanan: resmî test vektörleri, base32 gidiş-dönüş, ±1 adım toleransı, pencere dışı reddi,
 * tek-kullanım (replay) reddi ve biçim kapısı.
 */

/** RFC 6238 Ek B — SHA1 tohumu (20 bayt ASCII). */
const RFC_SEED = '12345678901234567890';
const RFC_SECRET_B32 = base32Encode(Buffer.from(RFC_SEED, 'ascii'));

describe('base32 (RFC 4648, padding-siz)', () => {
  it('RFC 4648 test vektörleri', () => {
    const vectors: Array<[string, string]> = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded);
      expect(base32Decode(encoded).toString('ascii')).toBe(plain);
    }
  });

  it('RFC 6238 tohumu bilinen base32 değerini verir', () => {
    expect(RFC_SECRET_B32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('gidiş-dönüş: rastgele sırlar bozulmadan çözülür', () => {
    for (let i = 0; i < 50; i++) {
      const secret = generateTotpSecret();
      expect(secret).toMatch(/^[A-Z2-7]+$/);
      expect(base32Encode(base32Decode(secret))).toBe(secret);
    }
    // Üretilen sır 160 bit (20 bayt) olmalı — RFC 4226 minimumunun (128 bit) üstünde.
    expect(base32Decode(generateTotpSecret()).length).toBe(20);
  });

  it("boşluk/tire/'=' dolgusu tolere edilir, geçersiz karakter HATA verir", () => {
    expect(base32Decode('MZXW 6YTB-OI').toString('ascii')).toBe('foobar');
    expect(base32Decode('MY======').toString('ascii')).toBe('f');
    expect(() => base32Decode('MZXW6YTB!')).toThrow();
    expect(() => base32Decode('MZXW6YT1')).toThrow(); // '1' alfabede yok (I ile karışmasın diye)
  });
});

describe('RFC 6238 test vektörleri (SHA1)', () => {
  // T (unix saniye) → 8 haneli beklenen kod (RFC 6238 Ek B).
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it('8 haneli kodlar birebir tutuyor', () => {
    for (const [t, expected] of vectors) {
      const step = totpStep(t * 1000);
      expect(totpCodeForStep(RFC_SECRET_B32, step, 8)).toBe(expected);
    }
  });

  it('6 hane = 8 hanenin son 6 hanesi (kırpma tutarlı)', () => {
    for (const [t, expected] of vectors) {
      const step = totpStep(t * 1000);
      expect(totpCodeForStep(RFC_SECRET_B32, step, 6)).toBe(expected.slice(-6));
    }
  });

  it('HOTP (RFC 4226 Ek D) sayaç vektörleri', () => {
    const key = Buffer.from(RFC_SEED, 'ascii');
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expected.forEach((code, counter) => expect(hotp(key, counter)).toBe(code));
  });
});

describe('verifyTotp — pencere ve biçim', () => {
  const now = 1_700_000_000_000; // sabit an (testler saat bağımsız)
  const step = totpStep(now);

  it('geçerli kod EŞLEŞEN ADIM numarasını döndürür (replay defteri için)', () => {
    const code = totpCodeForStep(RFC_SECRET_B32, step);
    expect(verifyTotp(RFC_SECRET_B32, code, { nowMs: now })).toBe(step);
  });

  it('±1 adım toleransı kabul edilir (saat kayması)', () => {
    for (const delta of [-1, 0, 1]) {
      const code = totpCodeForStep(RFC_SECRET_B32, step + delta);
      expect(verifyTotp(RFC_SECRET_B32, code, { nowMs: now })).toBe(step + delta);
    }
  });

  it('pencere DIŞI (±2 adım) reddedilir', () => {
    for (const delta of [-3, -2, 2, 3]) {
      const code = totpCodeForStep(RFC_SECRET_B32, step + delta);
      expect(verifyTotp(RFC_SECRET_B32, code, { nowMs: now })).toBeNull();
    }
  });

  it('30 sn sonra bir önceki kod hâlâ geçerli, 90 sn sonra DEĞİL', () => {
    const code = totpCodeForStep(RFC_SECRET_B32, step);
    expect(verifyTotp(RFC_SECRET_B32, code, { nowMs: now + TOTP_STEP_SEC * 1000 })).toBe(step);
    expect(verifyTotp(RFC_SECRET_B32, code, { nowMs: now + TOTP_STEP_SEC * 3000 })).toBeNull();
  });

  it('yanlış sır ile üretilmiş kod reddedilir', () => {
    const other = generateTotpSecret();
    const code = totpCodeForStep(other, step);
    expect(verifyTotp(RFC_SECRET_B32, code, { nowMs: now })).toBeNull();
  });

  it('biçim kapısı: boş / kısa / uzun / harf içeren kod reddedilir', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5', '００００００']) {
      expect(verifyTotp(RFC_SECRET_B32, bad, { nowMs: now })).toBeNull();
    }
  });

  it('boşluk/tire içeren kullanıcı girdisi normalize edilip kabul edilir', () => {
    const code = totpCodeForStep(RFC_SECRET_B32, step);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(normalizeTotpCode(spaced)).toBe(code);
    expect(verifyTotp(RFC_SECRET_B32, spaced, { nowMs: now })).toBe(step);
    expect(verifyTotp(RFC_SECRET_B32, `${code.slice(0, 3)}-${code.slice(3)}`, { nowMs: now })).toBe(
      step,
    );
  });

  it('bozuk sır doğrulamayı patlatmaz, null döner', () => {
    expect(verifyTotp('not-base32!!', '123456', { nowMs: now })).toBeNull();
    expect(verifyTotp('', '123456', { nowMs: now })).toBeNull();
  });
});

describe('verifyTotpOnce — tek kullanım (replay reddi)', () => {
  const now = 1_700_000_000_000;
  const step = totpStep(now);

  /** Bellek-içi adım defteri (üretimde Redis SET NX). true = ilk kez sahiplenildi. */
  function memoryClaimer() {
    const used = new Set<number>();
    return {
      used,
      claim: async (s: number) => (used.has(s) ? false : (used.add(s), true)),
    };
  }

  it('aynı kod İKİNCİ kez kabul EDİLMEZ', async () => {
    const { claim } = memoryClaimer();
    const code = totpCodeForStep(RFC_SECRET_B32, step);
    expect(await verifyTotpOnce(RFC_SECRET_B32, code, claim, { nowMs: now })).toBe(step);
    expect(await verifyTotpOnce(RFC_SECRET_B32, code, claim, { nowMs: now })).toBeNull();
    // Aynı adımın kodu pencere kaydıkça da (30 sn sonra) tekrar kullanılamaz.
    expect(
      await verifyTotpOnce(RFC_SECRET_B32, code, claim, { nowMs: now + TOTP_STEP_SEC * 1000 }),
    ).toBeNull();
  });

  it('kullanılan adım BİR SONRAKİ kodu engellemez', async () => {
    const { claim } = memoryClaimer();
    const first = totpCodeForStep(RFC_SECRET_B32, step);
    const next = totpCodeForStep(RFC_SECRET_B32, step + 1);
    expect(await verifyTotpOnce(RFC_SECRET_B32, first, claim, { nowMs: now })).toBe(step);
    expect(await verifyTotpOnce(RFC_SECRET_B32, next, claim, { nowMs: now })).toBe(step + 1);
  });

  it('geçersiz kod defteri KİRLETMEZ (sahiplenme hiç çağrılmaz)', async () => {
    const { used, claim } = memoryClaimer();
    expect(await verifyTotpOnce(RFC_SECRET_B32, '000000', claim, { nowMs: now })).toBeNull();
    expect(used.size).toBe(0);
    // Doğru kod hâlâ kabul edilir (yanlış deneme onu tüketmedi).
    const code = totpCodeForStep(RFC_SECRET_B32, step);
    expect(await verifyTotpOnce(RFC_SECRET_B32, code, claim, { nowMs: now })).toBe(step);
  });

  it('replay defteri TTL kodun ömrünü kapsar (≥ 2*window+1 adım)', () => {
    expect(totpReplayTtlSec()).toBeGreaterThanOrEqual(3 * TOTP_STEP_SEC);
  });
});

describe('otpauth URI', () => {
  it('authenticator uygulamalarının beklediği alanları taşır ve sırrı gövdede tutar', () => {
    const uri = buildOtpauthUri({
      secret: RFC_SECRET_B32,
      account: 'admin@ornek.com',
      issuer: 'Lisans Paneli',
    });
    expect(uri.startsWith('otpauth://totp/Lisans%20Paneli:admin%40ornek.com?')).toBe(true);
    const q = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));
    expect(q.get('secret')).toBe(RFC_SECRET_B32);
    expect(q.get('algorithm')).toBe('SHA1');
    expect(q.get('digits')).toBe('6');
    expect(q.get('period')).toBe('30');
    expect(q.get('issuer')).toBe('Lisans Paneli');
  });
});
