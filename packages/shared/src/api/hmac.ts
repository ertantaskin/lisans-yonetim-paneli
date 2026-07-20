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
export const HMAC_NONCE_TTL_SEC = 600;
export const HMAC_KEY_ROTATION_GRACE_SEC = 24 * 60 * 60;

/** İmzalanacak kanonik string. Gövde önce SHA-256'lanır. */
export function buildSignaturePayload(params: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodySha256Hex: string;
}): string {
  const { method, path, timestamp, nonce, bodySha256Hex } = params;
  return [method.toUpperCase(), path, timestamp, nonce, bodySha256Hex].join('\n');
}
