/**
 * HMAC imza sözleşmesi (§4). Her v1 isteği imzalıdır.
 *
 *   X-Signature = HMAC-SHA256(secret, METHOD\nPATH\nTS\nNONCE\nSHA256(body))
 *
 * - X-Timestamp: unix saniye, ±300sn tolerans (saat kayması)
 * - X-Nonce: Redis'te 10dk tekil (replay engeli)
 * - Anahtar rotasyonu: eski secret 24 saat paralel geçerli
 * - X-Trace-Id: uçtan uca taşınır
 */
export const HMAC_HEADERS = {
  apiKey: 'x-api-key',
  timestamp: 'x-timestamp',
  nonce: 'x-nonce',
  signature: 'x-signature',
  traceId: 'x-trace-id',
} as const;

export const HMAC_TIMESTAMP_TOLERANCE_SEC = 300;

/**
 * Nonce Redis TTL'i. Bir imza, timestamp'i geçerli olduğu SÜRECE tekrar oynatılabilir:
 * sabit bir timestamp için gerçek-zaman replay penceresi [T−tolerans, T+tolerans],
 * yani 2×tolerans genişliğinde. Nonce ilk görülüşte set edilir; en erken set anı
 * T−tolerans, en geç geçerli replay anı T+tolerans. TTL bu aralığı KAPSAMALI, yoksa
 * nonce erken düşüp sınır kenarında replay açığı doğar. Bu yüzden TTL > 2×tolerans:
 * güvenli marjla 2×tolerans + 60sn.
 */
export const HMAC_NONCE_TTL_SEC = 2 * HMAC_TIMESTAMP_TOLERANCE_SEC + 60;
export const HMAC_KEY_ROTATION_GRACE_SEC = 24 * 60 * 60;

/**
 * İmza yolu kanonikleştirme (§4). Aynı isteğin farklı proxy/rewrite kaynaklı yüzeysel
 * varyasyonları (fragment, query param sırası) AYNI kanonik yola indirgenir; imza
 * hem istemci (WP eklentisi) hem panel guard'ında birebir aynı yol üstünde kurulur.
 *
 * - Fragment (`#...`) asla ağ üstünde gitmez → atılır.
 * - Query yoksa pathname aynen döner (mevcut trafik query'siz → davranış değişmez).
 * - Query varsa param'lar '&' ile ayrılıp string sıralanır → sıralama tamper'ı ve
 *   proxy yeniden sıralaması imzayı bozmaz; query yine imzaya dâhil (tamper engeli).
 *
 * PHP karşılığı (class-panel-client.php `canonical_path`) bununla BİREBİR aynı olmalı.
 */
export function canonicalizePath(rawPath: string): string {
  const hashIdx = rawPath.indexOf('#');
  const noFrag = hashIdx >= 0 ? rawPath.slice(0, hashIdx) : rawPath;
  const qIdx = noFrag.indexOf('?');
  if (qIdx < 0) return noFrag;
  const pathname = noFrag.slice(0, qIdx);
  const sorted = noFrag
    .slice(qIdx + 1)
    .split('&')
    .filter((p) => p.length > 0)
    .sort();
  return sorted.length > 0 ? `${pathname}?${sorted.join('&')}` : pathname;
}

/**
 * İmzalanacak kanonik string. Gövde önce SHA-256'lanır; yol `canonicalizePath` ile
 * kanonikleştirilir (istemci/panel senkron).
 */
export function buildSignaturePayload(params: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodySha256Hex: string;
}): string {
  const { method, path, timestamp, nonce, bodySha256Hex } = params;
  return [method.toUpperCase(), canonicalizePath(path), timestamp, nonce, bodySha256Hex].join('\n');
}
