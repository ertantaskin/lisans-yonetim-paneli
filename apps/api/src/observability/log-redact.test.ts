/**
 * HANGİ SIZINTIYI KİLİTLER (SEC-2): envanter araması TAM lisans anahtarı kabul eder ve arama
 * QUERY STRING'de gider (`GET /v1/admin/license-items?search=…`). pino `redact.paths` yalnız
 * GÖVDEYİ kapsıyordu → anahtar, uygulama erişim logunda DÜZ METİN kalıyordu. Payload diskte
 * AES-256-GCM ile şifreliyken aynı değerin logda açık durması §9 ile çelişir.
 *
 * Testler serializer'ın kullandığı saf fonksiyonu DOĞRUDAN çağırır (DB/Nest gerekmez) ve
 * hem maskelemeyi hem de "tanı yeteneği kaybolmasın" kısıtını (yol + hassas OLMAYAN
 * parametreler okunur kalır) kilitler.
 */
import { describe, expect, it } from 'vitest';

import { REDACTED, sanitizeLogUrl } from './log-redact';

const KEY = 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE';

describe('sanitizeLogUrl — sır maskeleme', () => {
  it('TAM lisans anahtarı taşıyan search parametresini maskeler (asıl bulgu)', () => {
    const out = sanitizeLogUrl(`/v1/admin/license-items?search=${KEY}&pageSize=25`);
    expect(out).not.toContain(KEY);
    expect(out).toContain(`search=${REDACTED}`);
  });

  it('yol ve hassas OLMAYAN parametreler OKUNUR kalır (tanı yeteneği)', () => {
    const out = sanitizeLogUrl(`/v1/admin/license-items?status=available&search=${KEY}&page=3`);
    expect(out.startsWith('/v1/admin/license-items?')).toBe(true);
    expect(out).toContain('status=available');
    expect(out).toContain('page=3');
  });

  it('global arama (q) ve diğer sır adayı adlar da maskelenir', () => {
    expect(sanitizeLogUrl(`/v1/admin/search?q=${KEY}`)).toBe(`/v1/admin/search?q=${REDACTED}`);
    expect(sanitizeLogUrl('/v1/connect/claim?code=ABC123')).toBe(
      `/v1/connect/claim?code=${REDACTED}`,
    );
    expect(sanitizeLogUrl('/v1/admin/x?TOKEN=abc')).toBe(`/v1/admin/x?TOKEN=${REDACTED}`);
  });

  it('parametre ADI korunur — hangi filtrenin kullanıldığı loglardan hâlâ okunur', () => {
    expect(sanitizeLogUrl('/v1/admin/customers?search=ali')).toContain('search=');
  });
});

describe('sanitizeLogUrl — PII (e-posta) maskeleme korunur', () => {
  it('yol segmentindeki e-posta maskelenir (mevcut davranış)', () => {
    expect(sanitizeLogUrl('/v1/admin/customers/mus%40ornek.com/risk')).toBe(
      '/v1/admin/customers/[email]/risk',
    );
    expect(sanitizeLogUrl('/v1/admin/customers/mus@ornek.com')).toBe(
      '/v1/admin/customers/[email]',
    );
  });

  it('hassas olmayan bir parametrede e-posta geçerse yine maskelenir', () => {
    expect(sanitizeLogUrl('/v1/admin/orders?customer=mus@ornek.com')).toBe(
      '/v1/admin/orders?customer=[email]',
    );
  });
});

describe('sanitizeLogUrl — dayanıklılık (serializer ASLA fırlatmamalı)', () => {
  it('query yokken yol aynen döner', () => {
    expect(sanitizeLogUrl('/v1/health')).toBe('/v1/health');
  });

  it('bozuk yüzde-kodlaması fırlatmaz (URL/decodeURIComponent bunda patlar)', () => {
    expect(() => sanitizeLogUrl('/v1/admin/x?search=%E0%A4%A')).not.toThrow();
    expect(sanitizeLogUrl('/v1/admin/x?search=%E0%A4%A')).toContain(REDACTED);
  });

  it('değersiz/boş parçalar bozulmaz', () => {
    expect(sanitizeLogUrl('/v1/admin/x?')).toBe('/v1/admin/x?');
    expect(sanitizeLogUrl('/v1/admin/x?flag')).toBe('/v1/admin/x?flag');
    expect(sanitizeLogUrl('/v1/admin/x?a=1&&b=2')).toBe('/v1/admin/x?a=1&&b=2');
  });

  it('fragment kuyruğu korunur (log satırı bozulmasın)', () => {
    expect(sanitizeLogUrl(`/v1/admin/x?search=${KEY}#frag`)).toBe(
      `/v1/admin/x?search=${REDACTED}#frag`,
    );
  });
});
