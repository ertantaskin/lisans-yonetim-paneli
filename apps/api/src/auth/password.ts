import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Parola hash'leme — Node yerleşik scrypt (bellek-sert, ek bağımlılık yok).
 * Depolanan format: `scrypt$<saltHex>$<hashHex>`.
 */
const KEYLEN = 64;
const COST = 16384; // scrypt N (CPU/bellek maliyeti)

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N: COST });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, { N: COST });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Var olmayan/pasif kullanıcı yolunda da hash maliyeti ödenir (timing sızıntısı azaltma).
 * Sabit bir dummy hash'e karşı doğrulama yapılır.
 */
export const DUMMY_HASH = hashPassword('jetlisans-dummy-timing-guard');
