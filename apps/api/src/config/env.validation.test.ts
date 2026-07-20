import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    MASTER_KEY: 'x'.repeat(44),
    ADMIN_TOKEN: 'test-admin-token',
  };

  it('geçerli konfigi ayrıştırır ve varsayılanları uygular', () => {
    const env = validateEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(3001);
  });

  it('port string ise sayıya çevirir (coerce)', () => {
    const env = validateEnv({ ...base, API_PORT: '8080' });
    expect(env.API_PORT).toBe(8080);
  });

  it('DATABASE_URL eksikse fırlatır', () => {
    expect(() => validateEnv({ REDIS_URL: base.REDIS_URL })).toThrow(/doğrulaması başarısız/);
  });

  it('geçersiz URL reddedilir', () => {
    expect(() => validateEnv({ ...base, DATABASE_URL: 'not-a-url' })).toThrow();
  });
});
