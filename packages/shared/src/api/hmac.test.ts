import { describe, expect, it } from 'vitest';
import { buildSignaturePayload } from './hmac';

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
});
