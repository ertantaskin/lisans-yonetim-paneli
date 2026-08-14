/**
 * ERİŞİM LOGU REDAKSİYONU (§9/KVKK + SEC-2) — pino `req` serializer'ının kullandığı saf
 * yardımcılar. `app.module.ts` bunları çağırır; ayrı dosya olmasının sebebi test edilebilirlik:
 * `app.module` import etmek tüm Nest ağacını (env doğrulama, DB/Redis modülleri) ayağa kaldırır.
 *
 * İKİ AYRI SIZINTI KAPATILIR:
 *
 * 1) PII (e-posta): müşteri e-postası bazı uçlarda YOL içinde taşınır
 *    (`GET /v1/admin/customers/:email`). Retention/anonymize bu logları KAPSAMAZ → silme
 *    garantisi log tarihçesinde delik bırakırdı.
 *
 * 2) SIR (lisans anahtarı — SEC-2): envanter araması TAM anahtar kabul edecek şekilde
 *    genişletildi ve arama QUERY STRING'de gider
 *    (`GET /v1/admin/license-items?search=XXXXX-XXXXX-…`). Gövde redaksiyonu (`redact.paths`)
 *    YALNIZ gövdeyi kapsar → anahtar erişim logunda DÜZ METİN kalıyordu. Payload'lar diskte
 *    AES-256-GCM ile şifreliyken aynı değerin logda açık durması projenin kendi ilkesiyle
 *    çelişir (§9).
 *
 * TASARIM: yol ve diğer parametreler OKUNUR kalır — tanı yeteneği kaybolmamalı; yalnız
 * hassas parametrelerin DEĞERİ maskelenir. Maskeleme sessiz değil, görünür bir işaretle
 * (`[gizlendi]`) yapılır ki logu okuyan "burada bir değer vardı" olduğunu bilsin.
 *
 * KAPSAM SINIRI (dürüstlük): bu yalnız UYGULAMA logudur. Önündeki ters vekil (Caddy) kendi
 * erişim logunu AYRI tutar ve tam URL'i oraya yazar — o katman burada değiştirilemez;
 * kapatılması Caddy yapılandırmasında `log { … }` filtresi gerektirir (ops işi).
 */

/**
 * Değeri maskelenecek query parametreleri (küçük harfle karşılaştırılır).
 * `search`/`q`/`query`: serbest metin arama — TAM lisans anahtarı, hesap adı veya e-posta
 * taşıyabilir. `email`: müşteri filtreleri. `token`/`code`/`secret`/`key`/`password`:
 * ileride bir uç bunları query'ye koyarsa sessizce sızmasın (savunma derinliği).
 */
const SENSITIVE_QUERY_PARAMS = new Set([
  'search',
  'q',
  'query',
  'email',
  'token',
  'code',
  'secret',
  'key',
  'password',
]);

/** Maskeleme işareti — boş değerle karıştırılmasın diye görünür. */
export const REDACTED = '[gizlendi]';

/** E-posta benzeri diziler (yol veya query içinde, `%40` kodlu hâli dâhil). */
const EMAIL_LIKE_RE = /[^/?&=\s]+(?:@|%40)[^/?&=\s]+/gi;

/**
 * İstek URL'ini loglanabilir hâle getirir:
 *  - hassas query parametrelerinin DEĞERİ `[gizlendi]` olur (parametre ADI korunur),
 *  - kalan kısımda e-posta benzeri diziler `[email]` ile maskelenir (yol segmentleri dâhil).
 *
 * Ayrıştırma elle yapılır (WHATWG `URL` yerine): gelen değer göreli bir yoldur ve bozuk
 * yüzde-kodlaması taşıyabilir; `URL`/`decodeURIComponent` bunda FIRLATIR ve bir log
 * serializer'ının isteği düşürmesi kabul edilemez. Elle ayrıştırma çözme yapmaz → fırlatmaz.
 */
export function sanitizeLogUrl(url: string): string {
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return maskEmails(url);

  const pathname = url.slice(0, qIndex);
  const rawQuery = url.slice(qIndex + 1);

  // Fragment sunucuya gelmez ama bir istemci yine de gönderebilir → kuyruğu koru, karıştırma.
  const hashIndex = rawQuery.indexOf('#');
  const query = hashIndex === -1 ? rawQuery : rawQuery.slice(0, hashIndex);
  const tail = hashIndex === -1 ? '' : rawQuery.slice(hashIndex);

  const sanitizedQuery = query
    .split('&')
    .map((pair) => {
      if (!pair) return pair;
      const eq = pair.indexOf('=');
      if (eq === -1) return maskEmails(pair);
      const name = pair.slice(0, eq);
      // Parametre adı kodlanmış olabilir (`%73earch`); kaba karşılaştırma yeterli değilse
      // maskelemeyi ATLAMAK yerine adı olduğu gibi bırakıp değeri korumayız — bu yüzden ad
      // yalnız küçük harfe indirilir; bilinmeyen ad zaten hassas listesinde yoktur.
      if (SENSITIVE_QUERY_PARAMS.has(name.toLowerCase())) return `${name}=${REDACTED}`;
      return `${name}=${maskEmails(pair.slice(eq + 1))}`;
    })
    .join('&');

  return `${maskEmails(pathname)}?${sanitizedQuery}${tail}`;
}

/** E-posta benzeri dizileri maskeler (PII, §9/KVKK). */
function maskEmails(value: string): string {
  return value.replace(EMAIL_LIKE_RE, '[email]');
}
