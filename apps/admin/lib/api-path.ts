/**
 * Sunucu→API YOL KAPISI (SEC-1) — `lib/api.ts` içindeki apiGet/apiPost/apiSend/apiRaw
 * tarafından HER çağrıda uygulanır.
 *
 * NEDEN VAR: Next 15 sunucu aksiyonları TS tiplerini ÇALIŞMA ANINDA zorlamaz. Action uç
 * noktası dışarıdan da çağrılabilir ve argümanlar serileştirilmiş gövdeden gelir → bir
 * admin, `completeLineAction('../sites/<id>/rotate-secret?x=', '1')` benzeri bir çağrıyla
 * kendi girdisini API YOLUNA enjekte edebilir. WHATWG URL parser `..` segmentlerini ÇÖZDÜĞÜ
 * için istek BAŞKA bir admin ucuna düşer; Next sunucusu isteği kendi ADMIN_TOKEN'ı ile
 * yaptığından owner-only kapılar (rotate-secret, deployments, admin CRUD) bu yolla
 * ATLANABİLİRDİ. Bu modül, isteği YAPILMADAN ÖNCE reddeder.
 *
 * NEDEN AYRI DOSYA (server-only DEĞİL): `lib/api.ts` `import 'server-only'` taşır ve o paket
 * RSC dışında import edilince FIRLATIR → vitest altında test edilemez. Kapı saf bir fonksiyon
 * olduğu için buraya alındı; `lib/api-path.test.ts` doğrudan bunu koşar.
 *
 * KAPININ SÖZLEŞMESİ (kabul/ret):
 *  KABUL  — `/v1/` ile başlayan, tek `?` ile ayrılmış query taşıyabilen düz yollar.
 *           Query değerleri panelde HER ZAMAN `URLSearchParams`/`encodeURIComponent` ile
 *           üretilir; bunlar boşluk, `/`, `?`, `#` ve kontrol karakterlerini yüzdeyle kodlar.
 *  RET    — `/v1/` dışı önek · `.`/`..` dot-segment (yüzde-kodlu `%2e` dâhil) ·
 *           kodlanmamış `#` · birden fazla `?` · şema (`http:`/`https:`/`://`) ·
 *           boşluk ve kontrol karakteri · ters bölü · `//` (boş segment) ·
 *           yol içinde kodlanmış bölü (`%2f`/`%5c`) · query içinde ham `/`.
 *
 * SINIR (dürüstlük): kapı, enjekte edilen bir değerin AYNI önek altında KARDEŞ bir uca
 * kaymasını tek başına kapatamaz (ör. `.../assignments/<id>/reveal?x=` yazıp `/suspend`
 * ekini query'ye kırptırmak). Bunun otoriter savunması ÇAĞRI YERİNDEKİ kimlik doğrulamasıdır
 * (UUID kalıbı + `encodeURIComponent`); kapı ikinci savunma hattıdır.
 */

/** Güvenli olmayan yol → istek YAPILMAZ. `Error`'dan türer: mevcut yakalayıcılar çalışır. */
export class UnsafeApiPathError extends Error {
  constructor(public readonly reason: string) {
    // NOT: ham yol MESAJA GÖMÜLMEZ — saldırgan kontrolündeki metin arayüze/loga yansımasın.
    super(`Güvenlik: geçersiz API yolu (${reason}).`);
    this.name = 'UnsafeApiPathError';
  }
}

/**
 * Boşluk + tüm C0/C1 kontrol karakterleri. Regex yerine kod-noktası döngüsü kullanılır:
 * kaynak dosyada HAM kontrol karakteri bırakmamak için (görünmez bayt bakımı imkânsızlaştırır).
 * Meşru çağrılarda böyle bir karakter imkânsızdır (boşluk → `+`/`%20`, satır sonu → `%0A`).
 */
function hasControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Kayıt kimliği kalıbı — panelin ortak deseni (bkz. app/ops/actions.ts). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Değer, yola gömülmeye uygun bir kayıt kimliği mi (ÇALIŞMA ANI kontrolü). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

/**
 * Yol parçasını doğrular + kodlar. Kimlik UUID değilse `UnsafeApiPathError` fırlatır.
 * Sunucu AKSİYONLARI fırlatmaz (sözleşme `{ ok, error }`) → orada `isUuid()` ile önceden
 * kontrol edilir; bu yardımcı, fırlatması zaten beklenen okuma/queries katmanı içindir.
 */
export function uuidSegment(value: unknown): string {
  if (!isUuid(value)) throw new UnsafeApiPathError('kayit kimligi UUID degil');
  return encodeURIComponent(String(value).trim());
}

/** Dot-segment tespiti: `%2e` de WHATWG tarafından `.` olarak çözülür. */
function isDotSegment(segment: string): boolean {
  const decoded = segment.replace(/%2e/gi, '.');
  return decoded === '.' || decoded === '..';
}

/**
 * Yolu doğrular; ihlalde `UnsafeApiPathError` fırlatır (istek YAPILMAZ).
 * Yolu DEĞİŞTİRMEZ — sessiz "düzeltme" çağıranın yanlış varsayımını gizler ve aynı açığı
 * bir sonraki turda başka biçimde geri getirirdi (bu projede yaşanmış sınıf).
 */
export function assertSafePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new UnsafeApiPathError('yol metin degil');
  }
  // Tüm admin/site uçları `/v1/` altında yaşar → farklı önek zaten çağıran hatasıdır.
  // Bu kural aynı zamanda `//evil.example` (protokol-göreli) ve mutlak URL'i de eler.
  if (!path.startsWith('/v1/')) {
    throw new UnsafeApiPathError('yol /v1/ ile baslamiyor');
  }
  if (hasControlOrSpace(path)) {
    throw new UnsafeApiPathError('bosluk veya kontrol karakteri');
  }
  // Ters bölü: WHATWG özel-şema URL'lerinde `/` gibi davranır → gizli segment ayracı.
  if (path.includes('\\')) {
    throw new UnsafeApiPathError('ters bolu');
  }
  // Fragment sunucuya GİTMEZ; yolun geri kalanını sessizce kırpar → istem dışı uç.
  if (path.includes('#')) {
    throw new UnsafeApiPathError('kodlanmamis #');
  }
  if (/https?:/i.test(path) || path.includes('://')) {
    throw new UnsafeApiPathError('sema iceriyor');
  }

  const qIndex = path.indexOf('?');
  const pathname = qIndex === -1 ? path : path.slice(0, qIndex);
  const query = qIndex === -1 ? '' : path.slice(qIndex + 1);

  // Birden fazla `?`: meşru çağrılarda imkânsız (URLSearchParams `?` üretmez) → gizleme işareti.
  if (query.includes('?')) {
    throw new UnsafeApiPathError('birden fazla ?');
  }
  // Query'de ham `/` de imkânsız (`URLSearchParams`/`encodeURIComponent` onu `%2F` yapar).
  if (query.includes('/')) {
    throw new UnsafeApiPathError('query icinde kodlanmamis /');
  }
  if (pathname.includes('//')) {
    throw new UnsafeApiPathError('bos yol segmenti');
  }
  // Kodlanmış bölü: proxy/framework katmanları arasında yorum farkı doğurabilir; panelde
  // hiçbir meşru kimlik (UUID, e-posta, SKU) kodlanmış bölü içermez.
  if (/%2f|%5c/i.test(pathname)) {
    throw new UnsafeApiPathError('yolda kodlanmis bolu');
  }
  for (const segment of pathname.split('/')) {
    if (isDotSegment(segment)) {
      throw new UnsafeApiPathError('dot-segment (..)');
    }
  }
}
