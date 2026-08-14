import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) + Base32 (RFC 4648) — SIFIR BAĞIMLILIK, yalnız Node `crypto`.
 *
 * NEDEN elle yazıldı: TOTP toplam ~60 satırlık, donmuş ve tam belgelenmiş bir standarttır
 * (HMAC-SHA1 + dinamik kırpma). Bunun için üçüncü parti bir paket eklemek, panelin EN
 * KRİTİK kapısına (tek faktörden çift faktöre geçiş) denetlenmemiş bir tedarik-zinciri
 * yüzeyi katardı. Node'un kendi HMAC'i zaten sabit-zamanlı ve FIPS test vektörleriyle
 * doğrulanmış; test vektörleri RFC 6238 Ek B'den birim testlere kondu.
 *
 * Uyumluluk: Google Authenticator / Authy / 1Password / Bitwarden hepsi bu varsayılanları
 * kullanır — HMAC-SHA1, 30 sn adım, 6 hane. Algoritmayı DEĞİŞTİRMEYİN: SHA256/SHA512 bazı
 * mobil uygulamalarda sessizce yanlış kod üretir (URI parametresini yok sayarlar).
 */

/** RFC 4648 Base32 alfabesi (padding YOK — kimlik doğrulama uygulamaları '=' istemez). */
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Varsayılan parametreler — authenticator uygulamalarının varsaydığı değerler. */
export const TOTP_STEP_SEC = 30;
export const TOTP_DIGITS = 6;

/**
 * Kabul penceresi: ±1 adım (yani en fazla 90 sn'lik bir bant). DAHA GENİŞ AÇMAYIN —
 * pencere her adım için bir kod daha geçerli kılar, yani brute-force yüzeyini doğrusal
 * büyütür ve çalınmış bir kodun ömrünü uzatır. ±1, gerçek dünyadaki saat kaymasını
 * (NTP'siz telefon) karşılamaya yeter.
 */
export const TOTP_WINDOW = 1;

/** Sırrın bayt uzunluğu. RFC 4226 en az 128 bit ister; 160 bit (=32 base32 karakteri) standarttır. */
const SECRET_BYTES = 20;

/** Base32 kodlama (RFC 4648, padding'siz). */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // Artan bitler soldan hizalanıp son karaktere yazılır (padding eklenmez).
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Base32 çözme. Boşluk ve '=' dolgusu tolere edilir (kullanıcı sırrı elle yapıştırırsa
 * 4'lü gruplar hâlinde kopyalanmış olabilir); alfabede olmayan karakter HATA verir —
 * sessizce atlamak, yanlış yazılmış bir sırrı "çalışıyor" gibi gösterirdi.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Geçersiz base32 karakteri');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Yeni TOTP sırrı (base32, padding'siz). CSPRNG — Math.random ASLA. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/**
 * HOTP (RFC 4226) — sayaç tabanlı tek kullanımlık parola. TOTP bunun sayacı zamandan
 * türetilmiş hâlidir.
 */
export function hotp(key: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  // Dinamik kırpma (RFC 4226 §5.3): son bayttın alt 4 biti offset'i verir.
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Verilen anın adım (time-step) numarası — replay defterinin anahtarı da budur. */
export function totpStep(nowMs: number = Date.now(), stepSec: number = TOTP_STEP_SEC): number {
  return Math.floor(nowMs / 1000 / stepSec);
}

/** Belirli bir adım için beklenen kod (test ve kurulum önizlemesi için). */
export function totpCodeForStep(
  secretB32: string,
  step: number,
  digits: number = TOTP_DIGITS,
): string {
  return hotp(base32Decode(secretB32), step, digits);
}

/** Şu anki kod. */
export function totpCode(secretB32: string, nowMs: number = Date.now()): string {
  return totpCodeForStep(secretB32, totpStep(nowMs));
}

/** Kullanıcı girdisini normalize eder: boşluk/tire atılır (uygulamalar '123 456' gösterir). */
export function normalizeTotpCode(raw: string): string {
  return raw.replace(/[\s-]/g, '');
}

/** İki eşit uzunluklu dizeyi SABİT ZAMANDA karşılaştırır (uzunluk farkı gizli değil). */
function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Kodu ±window adım toleransıyla doğrular.
 *
 * @returns EŞLEŞEN ADIM NUMARASI (replay defterine yazılacak değer) ya da null.
 *
 * SABİT ZAMAN: döngü ilk eşleşmede KIRILMAZ — aksi hâlde "kod hangi adımda tuttu"
 * bilgisi zamanlamadan sızardı (saat kayması oraklı). Tüm adaylar her koşuda üretilir.
 */
export function verifyTotp(
  secretB32: string,
  code: string,
  opts: { nowMs?: number; window?: number; digits?: number; stepSec?: number } = {},
): number | null {
  const digits = opts.digits ?? TOTP_DIGITS;
  const window = opts.window ?? TOTP_WINDOW;
  const stepSec = opts.stepSec ?? TOTP_STEP_SEC;
  const candidate = normalizeTotpCode(code);
  // Biçim kapısı: yalnız `digits` uzunluğunda rakam. (Uzunluk/biçim sır değildir; burada
  // erken dönmek HMAC maliyetini de gereksiz yere ödememizi sağlar.)
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return null;

  let key: Buffer;
  try {
    key = base32Decode(secretB32);
  } catch {
    return null; // bozuk sır → doğrulama başarısız (çağıran kurulumu sıfırlamalı)
  }
  if (key.length === 0) return null;

  const current = totpStep(opts.nowMs ?? Date.now(), stepSec);
  let matched: number | null = null;
  for (let delta = -window; delta <= window; delta++) {
    const step = current + delta;
    const expected = hotp(key, step, digits);
    // `matched === null` kontrolü ATAMADA yapılır, döngü kırılmaz (bkz. sabit zaman notu).
    if (constantTimeEquals(expected, candidate) && matched === null) matched = step;
  }
  return matched;
}

/**
 * TEK KULLANIMLIK doğrulama: kod geçerliyse ADIMI "kullanıldı" olarak işaretlemeye çalışır;
 * işaret zaten varsa (aynı kod ikinci kez) doğrulama BAŞARISIZ sayılır.
 *
 * NEDEN burada: replay koruması TOTP'nin ayrılmaz parçasıdır (RFC 6238 §5.2 açıkça ister) ama
 * saklama yeri altyapıya bağlıdır. `claimStep` enjekte edilerek çekirdek SAF kalır → birim
 * testlerde bellek-içi Set, üretimde Redis `SET NX` kullanılır (tek yazar kazanır).
 *
 * @param claimStep adımı atomik olarak sahiplenir; true = ilk kez (kabul), false = zaten kullanılmış.
 * @returns kabul edilen adım ya da null (geçersiz kod VEYA tekrar kullanım).
 */
export async function verifyTotpOnce(
  secretB32: string,
  code: string,
  claimStep: (step: number) => Promise<boolean>,
  opts: { nowMs?: number; window?: number; digits?: number; stepSec?: number } = {},
): Promise<number | null> {
  const step = verifyTotp(secretB32, code, opts);
  if (step === null) return null;
  const fresh = await claimStep(step);
  return fresh ? step : null;
}

/**
 * Replay defterinin yaşaması gereken süre (saniye): pencere iki yana açık olduğundan bir kod
 * en fazla (2*window+1) adım boyunca geçerlidir; üstüne bir adım pay bırakılır. Daha kısası
 * kodun ömrü dolmadan defteri silip replay'e kapı açardı.
 */
export function totpReplayTtlSec(
  window: number = TOTP_WINDOW,
  stepSec: number = TOTP_STEP_SEC,
): number {
  return (2 * window + 2) * stepSec;
}

/**
 * `otpauth://` kurulum URI'si (Key Uri Format). QR kütüphanesi EKLENMEDİ:
 * (a) yeni bir bağımlılık = yeni tedarik-zinciri yüzeyi (bu iş tam da o riski azaltmak için),
 * (b) her authenticator uygulaması "kurulum anahtarını elle gir" akışını destekler,
 * (c) QR üretimi istemcide yapılırsa sır DOM'a/oradan uzantılara açılır, sunucuda yapılırsa
 *     sır bir GÖRSEL olarak log/proxy/önbelleklere düşebilir. Metin URI + base32 sır yeterlidir.
 */
export function buildOtpauthUri(opts: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
