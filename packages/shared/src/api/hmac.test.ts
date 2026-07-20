import { describe, expect, it } from 'vitest';
import {
  HMAC_NONCE_TTL_SEC,
  HMAC_TIMESTAMP_TOLERANCE_SEC,
  buildSignaturePayload,
  canonicalizePath,
} from './hmac';

describe('buildSignaturePayload', () => {
  it('kanonik string üretir (METHOD\\nPATH\\nTS\\nNONCE\\nbodyHash)', () => {
    const payload = buildSignaturePayload({
      method: 'post',
      path: '/v1/orders',
      timestamp: '1700000000',
      nonce: 'abc123',
      bodySha256Hex: 'deadbeef',
    });
    expect(payload).toBe('POST\n/v1/orders\n1700000000\nabc123\ndeadbeef');
  });

  it('metodu büyük harfe çevirir', () => {
    const payload = buildSignaturePayload({
      method: 'get',
      path: '/v1/health',
      timestamp: '1',
      nonce: 'n',
      bodySha256Hex: 'h',
    });
    expect(payload.startsWith('GET\n')).toBe(true);
  });

  it('yolu kanonikleştirir (query sırası imzayı değiştirmez)', () => {
    const base = { method: 'GET', timestamp: '1', nonce: 'n', bodySha256Hex: 'h' };
    const a = buildSignaturePayload({ ...base, path: '/v1/x?b=2&a=1' });
    const b = buildSignaturePayload({ ...base, path: '/v1/x?a=1&b=2' });
    expect(a).toBe(b);
    expect(a).toContain('/v1/x?a=1&b=2');
  });
});

describe('canonicalizePath', () => {
  it('query yoksa pathname aynen döner (mevcut trafik değişmez)', () => {
    expect(canonicalizePath('/v1/orders')).toBe('/v1/orders');
  });

  it('query param sırasını normalize eder', () => {
    expect(canonicalizePath('/p?z=9&a=1&m=5')).toBe('/p?a=1&m=5&z=9');
  });

  it('fragmenti atar', () => {
    expect(canonicalizePath('/p#section')).toBe('/p');
    expect(canonicalizePath('/p?a=1#x')).toBe('/p?a=1');
  });

  it('boş query pathname olarak sadeleşir', () => {
    expect(canonicalizePath('/p?')).toBe('/p');
  });
});

describe('nonce TTL sınır invaryantı (§4)', () => {
  it('TTL replay penceresini (2×tolerans) kesin kapsar', () => {
    // Nonce erken düşerse sınır kenarında replay açığı doğar → TTL > 2×tolerans olmalı.
    expect(HMAC_NONCE_TTL_SEC).toBeGreaterThan(2 * HMAC_TIMESTAMP_TOLERANCE_SEC);
  });
});
