import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Parola hash'leme — Node yerleşik scrypt (bellek-sert, ek bağımlılık yok).
 * Depolanan format: `scrypt$<saltHex>$<hashHex>` (DEĞİŞMEDİ — mevcut hash'ler aynen doğrulanır).
 *
 * ASENKRON (senkron sürümden taşındı): `scryptSync` bir doğrulamada ~60-100 ms boyunca API'nin
 * TEK event loop'unu BLOKLAR; aynı süreç sipariş push/teslimatını da servis ettiğinden ucuz bir
 * login seli teslimatı yavaşlatabiliyordu. Asenkron scrypt işi libuv thread havuzunda koşar →
 * event loop serbest kalır. Hash formatı, maliyet parametreleri ve doğrulama DAVRANIŞI birebir
 * aynıdır (yalnız senkron → asenkron).
 */
const KEYLEN = 64;
const COST = 16384; // scrypt N (CPU/bellek maliyeti)

/**
 * scrypt callback API'sinin Promise sarmalayıcısı. (promisify, options parametreli overload'da
 * tip bilgisini kaybettiği için elle sarmalandı.) Argüman doğrulama hatası executor içinde
 * senkron fırlarsa da Promise reddine dönüşür → çağıran tek try/catch ile kapsar.
 */
function scryptAsync(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N: COST }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let actual: Buffer;
  try {
    actual = await scryptAsync(password, salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const DUMMY_PASSWORD = 'lisans-panel-dummy-timing-guard';
let dummyHashPromise: Promise<string> | null = null;

/**
 * Var olmayan/pasif kullanıcı yolunda da hash maliyeti ödenir (timing sızıntısı azaltma):
 * sabit bir dummy hash'e karşı doğrulama yapılır. Asenkron olduğu için modül yüklenirken
 * ÜRETİLMEZ — ilk çağrıda bir kez hesaplanıp önbelleklenir (tembel singleton). Böylece modül
 * yüklenirken ne event loop bloklanır ne de sahipsiz (unhandled) bir promise kalır; hata
 * durumunda önbellek temizlenir ki kalıcı bozulma oluşmasın.
 */
export function dummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(DUMMY_PASSWORD).catch((e: unknown) => {
      dummyHashPromise = null;
      throw e;
    });
  }
  return dummyHashPromise;
}
