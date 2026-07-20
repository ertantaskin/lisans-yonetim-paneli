import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const DEK_LEN = 32;
const KEY_LEN = 32;
const FORMAT_VERSION = 'v1';

/**
 * AES-256-GCM envelope encryption (MIMARI.md §8).
 *
 * Her payload rastgele bir DEK (data encryption key) ile şifrelenir; DEK de master
 * key (KEK) ile sarılır. Böylece master key rotasyonu tüm veriyi yeniden şifrelemeyi
 * gerektirmez ve master key DB'den AYRI secret store'da tutulabilir.
 *
 * Depolanan format (payload_enc kolonu), tümü base64url ve '.' ile ayrık:
 *   v1.<iv>.<tag>.<ciphertext>.<wrapIv>.<wrapTag>.<wrappedDek>
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private masterKey!: Buffer;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const b64 = this.config.get<string>('MASTER_KEY');
    if (!b64) {
      throw new Error('MASTER_KEY tanımlı değil — payload şifreleme çalışamaz.');
    }
    const key = Buffer.from(b64, 'base64');
    if (key.length !== KEY_LEN) {
      throw new Error(
        `MASTER_KEY 32 byte olmalı (base64). Şu an ${key.length} byte. Üret: openssl rand -base64 32`,
      );
    }
    this.masterKey = key;
  }

  /** Düz metin payload'ı envelope ile şifreler; payload_enc kolonuna yazılacak string döner. */
  encrypt(plaintext: string): string {
    const dek = randomBytes(DEK_LEN);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALG, dek, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    // DEK'i master key ile sar.
    const wrapIv = randomBytes(IV_LEN);
    const wrapCipher = createCipheriv(ALG, this.masterKey, wrapIv);
    const wrappedDek = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);
    const wrapTag = wrapCipher.getAuthTag();

    return [
      FORMAT_VERSION,
      b64(iv),
      b64(tag),
      b64(ciphertext),
      b64(wrapIv),
      b64(wrapTag),
      b64(wrappedDek),
    ].join('.');
  }

  /** payload_enc string'ini çözer. Bozuk/oynanmış veri GCM tag doğrulamasında hata verir. */
  decrypt(blob: string): string {
    const parts = blob.split('.');
    if (parts.length !== 7 || parts[0] !== FORMAT_VERSION) {
      throw new Error('Geçersiz şifreli payload formatı');
    }
    const [, iv, tag, ciphertext, wrapIv, wrapTag, wrappedDek] = parts.map((p, i) =>
      i === 0 ? p : ub64(p),
    ) as [string, Buffer, Buffer, Buffer, Buffer, Buffer, Buffer];

    // Önce DEK'i aç.
    const unwrap = createDecipheriv(ALG, this.masterKey, wrapIv);
    unwrap.setAuthTag(wrapTag);
    const dek = Buffer.concat([unwrap.update(wrappedDek), unwrap.final()]);

    // Sonra payload'ı aç.
    const decipher = createDecipheriv(ALG, dek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /**
   * Mükerrer key engeli için ANAHTARLI (HMAC) içerik hash'i. Deterministik ama
   * master key olmadan hesaplanamaz → DB'yi ele geçiren biri known-plaintext ile
   * "bu key var mı" oraklını çalıştıramaz (§8). Master key sabit olduğu için dedup korunur.
   */
  payloadHash(plaintext: string): string {
    return createHmac('sha256', this.masterKey).update(plaintext, 'utf8').digest('hex');
  }

  /** Son 5 hane araması için (Ctrl+K, §13) — anahtarlı, son 5 hane sızmaz. */
  payloadSuffixHash(plaintext: string): string {
    return createHmac('sha256', this.masterKey)
      .update(`suffix:${plaintext.slice(-5)}`, 'utf8')
      .digest('hex');
  }

  /**
   * Sabit-zamanlı string karşılaştırma (imza/token doğrulama). Her iki girdi önce
   * sabit uzunluğa (SHA-256) indirgenir → uzunluk timing ile sızmaz.
   */
  static safeEqual(a: string, b: string): boolean {
    const ha = createHash('sha256').update(a, 'utf8').digest();
    const hb = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(ha, hb);
  }
}

function b64(buf: Buffer): string {
  return buf.toString('base64url');
}
function ub64(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}
