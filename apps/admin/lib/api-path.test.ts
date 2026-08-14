/**
 * HANGİ AÇIĞI KİLİTLER (SEC-1): sunucu aksiyonları TS tiplerini çalışma anında zorlamaz;
 * action uç noktası dışarıdan serileştirilmiş argümanlarla çağrılabilir. Kimlik doğrudan API
 * yoluna gömüldüğü için `completeLineAction('../sites/<id>/rotate-secret?x=', '1')` benzeri
 * bir çağrı, WHATWG URL normalizasyonu `..`'yı çözdüğünden BAŞKA bir admin ucuna düşüyordu —
 * ve Next sunucusu isteği kendi ADMIN_TOKEN'ı ile yaptığı için owner-only kapılar atlanıyordu.
 *
 * Testler HEM kabulü HEM reddi kilitler: kabul tarafında gerçek çağrı yerlerinden alınmış
 * yollar vardır (query'li olanlar dâhil) — kapı sertleştirilirken meşru trafiğin kırılması
 * bu projede yaşanmış bir sınıftır (bkz. HMAC IP limiti, WP `is_secure_panel_url`).
 */
import { describe, expect, it } from 'vitest';

import { assertSafePath, isUuid, UnsafeApiPathError, uuidSegment } from './api-path';

const UUID = '11111111-2222-4333-8444-555555555555';

describe('assertSafePath — KABUL (gerçek çağrı yerlerinden)', () => {
  const ACCEPTED = [
    '/v1/admin/orders',
    `/v1/admin/orders/${UUID}`,
    `/v1/admin/fulfillments/${UUID}/complete`,
    `/v1/admin/sites/${UUID}/rotate-secret`,
    `/v1/admin/product-categories/${UUID}`,
    '/v1/admin/live?limit=15',
    '/v1/admin/customers?search=a%40b.com&siteId=' + UUID,
    // Envanter araması TAM lisans anahtarı kabul eder (tire içerir, kodlanmıştır).
    '/v1/admin/license-items?search=AAAAA-BBBBB-CCCCC-DDDDD-EEEEE&pageSize=25',
    // E-posta yol segmentinde: `@` → `%40`, nokta korunur (dot-segment DEĞİL).
    '/v1/admin/customers/mus%40ornek.com/risk',
    // Boşluk içeren arama: URLSearchParams `+`, encodeURIComponent `%20` üretir — ikisi de geçer.
    '/v1/admin/search?q=windows+pro',
    '/v1/admin/search?q=windows%20pro',
  ];
  for (const path of ACCEPTED) {
    it(`kabul: ${path}`, () => {
      expect(() => assertSafePath(path)).not.toThrow();
    });
  }
});

describe('assertSafePath — RET', () => {
  const REJECTED: Array<[string, string]> = [
    ['yol geçişi (asıl açık)', `/v1/admin/fulfillments/../sites/${UUID}/rotate-secret?x=/complete`],
    ['yüzde-kodlu dot-segment', `/v1/admin/fulfillments/%2e%2e/sites/${UUID}/rotate-secret`],
    ['tek nokta segmenti', '/v1/admin/./orders'],
    ['/v1/ dışı önek', '/health'],
    ['protokol-göreli', '//evil.example/v1/admin/orders'],
    ['mutlak URL', 'https://evil.example/v1/admin/orders'],
    ['gömülü şema', '/v1/admin/orders?next=https://evil.example'],
    ['ters bölü', '/v1/admin/orders\\..\\sites'],
    ['kodlanmamış #', '/v1/admin/orders#/../sites'],
    ['birden fazla ?', '/v1/admin/orders?a=1?b=2'],
    ['query içinde ham /', '/v1/admin/assignments/x/reveal?pad=/suspend'],
    ['boş segment', '/v1/admin//orders'],
    ['kodlanmış bölü', '/v1/admin/orders/a%2f..%2fsites'],
    ['boşluk', '/v1/admin/orders/ 1'],
    ['satır sonu (log/başlık enjeksiyonu sınıfı)', '/v1/admin/orders/\n/sites'],
    ['NUL', '/v1/admin/orders/\u0000'],
  ];
  for (const [label, path] of REJECTED) {
    it(`ret: ${label}`, () => {
      expect(() => assertSafePath(path)).toThrow(UnsafeApiPathError);
    });
  }

  it('metin olmayan girdi reddedilir (action argümanı serileştirilmiş gelir)', () => {
    expect(() => assertSafePath(undefined)).toThrow(UnsafeApiPathError);
    expect(() => assertSafePath(null)).toThrow(UnsafeApiPathError);
    expect(() => assertSafePath(42)).toThrow(UnsafeApiPathError);
    expect(() => assertSafePath('')).toThrow(UnsafeApiPathError);
  });

  it('hata mesajı HAM yolu yansıtmaz (saldırgan metni arayüze/loga taşımaz)', () => {
    try {
      assertSafePath('/v1/admin/../../etc/passwd');
      throw new Error('fırlatmalıydı');
    } catch (e) {
      expect(e).toBeInstanceOf(UnsafeApiPathError);
      expect((e as Error).message).not.toContain('passwd');
    }
  });
});

describe('isUuid / uuidSegment — çağrı yeri doğrulaması', () => {
  it('geçerli kimliği kabul eder (baştaki/sondaki boşluk kırpılır)', () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid(` ${UUID} `)).toBe(true);
    expect(uuidSegment(UUID)).toBe(UUID);
  });

  it('yol enjeksiyonu taşıyan değeri reddeder', () => {
    expect(isUuid(`${UUID}/reveal`)).toBe(false);
    expect(isUuid('../sites')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(() => uuidSegment('../sites')).toThrow(UnsafeApiPathError);
  });
});
