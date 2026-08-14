import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Parola hash'leme — Node yerleşik scrypt (bellek-sert, ek bağımlılık yok).
 *
 * ── DEPOLANAN FORMAT ────────────────────────────────────────────────────────
 * GÜNCEL: `scrypt$N=131072,r=8,p=1$<saltHex>$<hashHex>`  (4 parça)
 * ESKİ  : `scrypt$<saltHex>$<hashHex>`                    (3 parça)
 *
 * Maliyet parametreleri ESKİ formatta SAKLANMIYORDU; bu yüzden N'i tek başına yükseltmek
 * mevcut TÜM hash'leri doğrulanamaz hâle getirir ve panelde tek bir admin bile giriş
 * yapamazdı (sessiz, geri dönüşü elle olan bir kilitlenme). Format bu yüzden parametre
 * taşıyacak şekilde genişletildi:
 *  - 3 parçalı (eski) hash'ler ESKİ parametrelerle (N=2^14) doğrulanmaya DEVAM eder,
 *  - 4 parçalı hash'ler kendi taşıdıkları parametrelerle doğrulanır,
 *  - başarılı girişte eski hash sessizce GÜNCEL parametrelerle yeniden yazılır
 *    (bkz. `needsRehash` + AdminUsersService.login → rehash-on-login).
 * Böylece geçiş operatör müdahalesi olmadan, girişleri bozmadan tamamlanır.
 *
 * ── MALİYET (D4) ────────────────────────────────────────────────────────────
 * N 2^14 → 2^17 (OWASP 2026 asgarisi). Bu makinede ÖLÇÜLDÜ: 26 ms/16 MB → 192 ms/128 MB.
 * Parametreler artık hash'in İÇİNDE olduğu için ileride tekrar yükseltmek (ya da bellek
 * kısıtı çıkarsa OWASP'ın denk alternatifine — N=2^14, p=5 — dönmek) yalnız aşağıdaki
 * `CURRENT_PARAMS` sabitini değiştirmeyi gerektirir; eski hash'ler yine çözülür.
 *
 * ASENKRON: `scryptSync` bir doğrulamada API'nin TEK event loop'unu BLOKLAR; aynı süreç
 * sipariş push/teslimatını da servis ettiğinden ucuz bir login seli teslimatı yavaşlatabilir.
 * Asenkron scrypt işi libuv thread havuzunda koşar → event loop serbest kalır. (Yeni N ile
 * çağrı başına ~128 MB ayrılır; login yolu hem IP hem hesap bazında hız-sınırlıdır.)
 */
const KEYLEN = 64;

type ScryptParams = { N: number; r: number; p: number };

/** ESKİ (parametresiz) formatın örtük parametreleri — DEĞİŞTİRİLEMEZ, tarihsel sabit. */
const LEGACY_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };

/** Yeni hash'lerde kullanılan güncel maliyet (OWASP 2026: N=2^17, r=8, p=1). */
const CURRENT_PARAMS: ScryptParams = { N: 131072, r: 8, p: 1 };

/**
 * ZORUNLU (ölçüldü): Node'un scrypt varsayılan `maxmem` sınırı 32 MB'tır ve N=2^17, r=8
 * 128 MB ister → maxmem verilmezse çağrı `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` ile ÇÖKER.
 * Bu yüzden hem hash hem DOĞRULAMA yolunda daima geçirilir (verify'da unutulsaydı yeni
 * formatlı hash'lerin hiçbiri doğrulanamaz, yani herkes kilitlenirdi).
 */
const MAXMEM = 256 * 1024 * 1024;

/**
 * Depodan okunan parametrelerin üst sınırı (savunma derinliği). Hash'ler yalnız bu uygulama
 * tarafından yazılır, ama bozuk/kurcalanmış bir satırdaki N=2^30 tek bir doğrulama isteğiyle
 * süreci OOM'a sürükleyebilirdi. Sınır dışı değer = doğrulama başarısız (istisna değil).
 */
const MAX_N = 1 << 20;
const MAX_RP = 16;

/** `N=131072,r=8,p=1` */
function encodeParams(p: ScryptParams): string {
  return `N=${p.N},r=${p.r},p=${p.p}`;
}

/** Katı ayrıştırma: yalnız beklenen biçim + akla yatkın aralık kabul edilir; aksi hâlde null. */
function parseParams(raw: string): ScryptParams | null {
  const m = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(raw);
  if (!m) return null;
  const N = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  if (!Number.isSafeInteger(N) || N < 2 || N > MAX_N || (N & (N - 1)) !== 0) return null; // 2'nin kuvveti
  if (!Number.isSafeInteger(r) || r < 1 || r > MAX_RP) return null;
  if (!Number.isSafeInteger(p) || p < 1 || p > MAX_RP) return null;
  if (128 * N * r > MAXMEM) return null;
  return { N, r, p };
}

/**
 * scrypt callback API'sinin Promise sarmalayıcısı. (promisify, options parametreli overload'da
 * tip bilgisini kaybettiği için elle sarmalandı.) Argüman doğrulama hatası executor içinde
 * senkron fırlarsa da Promise reddine dönüşür → çağıran tek try/catch ile kapsar.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  params: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { ...params, maxmem: MAXMEM }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, CURRENT_PARAMS);
  return `scrypt$${encodeParams(CURRENT_PARAMS)}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Depolanan dizeyi parçalar; tanınmayan/bozuk format için null (istisna fırlatmaz). */
function decodeStored(
  stored: string,
): { params: ScryptParams; salt: Buffer; expected: Buffer } | null {
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt') return null;
  let params: ScryptParams | null;
  let saltHex: string | undefined;
  let hashHex: string | undefined;
  if (parts.length === 3) {
    // Eski format: parametre taşımaz → tarihsel varsayılan.
    params = LEGACY_PARAMS;
    saltHex = parts[1];
    hashHex = parts[2];
  } else if (parts.length === 4) {
    params = parseParams(parts[1]!);
    saltHex = parts[2];
    hashHex = parts[3];
  } else {
    return null;
  }
  if (!params || !saltHex || !hashHex) return null;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (salt.length === 0 || expected.length === 0) return null;
  return { params, salt, expected };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const decoded = decodeStored(stored);
  if (!decoded) return false;
  let actual: Buffer;
  try {
    actual = await scryptAsync(password, decoded.salt, decoded.expected.length, decoded.params);
  } catch {
    return false;
  }
  return actual.length === decoded.expected.length && timingSafeEqual(actual, decoded.expected);
}

/**
 * Bu hash GÜNCEL maliyetin altında mı? (rehash-on-login kararı.)
 *
 * Yalnız ÇÖZÜLEBİLEN ve parametresi güncelden farklı olan hash'ler için true döner —
 * bozuk/tanınmayan dize zaten doğrulamayı geçemez, onu "yenilenmeli" saymak anlamsızdır.
 * Çağıran bunu ANCAK parola doğrulandıktan sonra kullanmalıdır (düz parola elde olmadan
 * yeniden hash üretilemez).
 */
export function needsRehash(stored: string): boolean {
  const decoded = decodeStored(stored);
  if (!decoded) return false;
  const { N, r, p } = decoded.params;
  return N !== CURRENT_PARAMS.N || r !== CURRENT_PARAMS.r || p !== CURRENT_PARAMS.p;
}

const DUMMY_PASSWORD = 'lisans-panel-dummy-timing-guard';
let dummyHashPromise: Promise<string> | null = null;

/**
 * Var olmayan/pasif kullanıcı yolunda da hash maliyeti ödenir (timing sızıntısı azaltma):
 * sabit bir dummy hash'e karşı doğrulama yapılır. Asenkron olduğu için modül yüklenirken
 * ÜRETİLMEZ — ilk çağrıda bir kez hesaplanıp önbelleklenir (tembel singleton). Böylece modül
 * yüklenirken ne event loop bloklanır ne de sahipsiz (unhandled) bir promise kalır; hata
 * durumunda önbellek temizlenir ki kalıcı bozulma oluşmasın.
 *
 * NOT: dummy hash GÜNCEL parametrelerle üretilir → bilinmeyen kimlik yolu, gerçek (yenilenmiş)
 * hesapla AYNI maliyeti öder; aksi hâlde süre farkı hesap varlığını sızdırırdı.
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
