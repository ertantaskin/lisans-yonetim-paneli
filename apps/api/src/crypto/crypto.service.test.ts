import { randomBytes } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from './crypto.service';

function makeService(): CryptoService {
  const masterKey = randomBytes(32).toString('base64');
  const config = { get: (k: string) => (k === 'MASTER_KEY' ? masterKey : undefined) };
  const svc = new CryptoService(config as unknown as ConfigService);
  svc.onModuleInit();
  return svc;
}

describe('CryptoService (AES-256-GCM envelope)', () => {
  let svc: CryptoService;
  beforeEach(() => {
    svc = makeService();
  });

  it('şifreler ve geri çözer (round-trip)', () => {
    const secret = 'WIN10-PRO-XYZ12-ABCDE-98765';
    const enc = svc.encrypt(secret);
    expect(enc).not.toContain(secret);
    expect(svc.decrypt(enc)).toBe(secret);
  });

  it('her şifreleme farklı ciphertext üretir (rastgele DEK/IV)', () => {
    const a = svc.encrypt('aynı-metin');
    const b = svc.encrypt('aynı-metin');
    expect(a).not.toBe(b);
    expect(svc.decrypt(a)).toBe(svc.decrypt(b));
  });

  it('oynanmış veri GCM tag doğrulamasında hata verir', () => {
    const enc = svc.encrypt('gizli');
    const parts = enc.split('.');
    // ciphertext'i boz
    parts[3] = Buffer.from('bozuk-veri').toString('base64url');
    expect(() => svc.decrypt(parts.join('.'))).toThrow();
  });

  it('payloadHash anahtarlı + deterministik (mükerrer engeli)', () => {
    expect(svc.payloadHash('abc')).toBe(svc.payloadHash('abc'));
    expect(svc.payloadHash('abc')).not.toBe(svc.payloadHash('abd'));
    // Farklı master key → farklı hash (known-plaintext oracle engeli)
    expect(makeService().payloadHash('abc')).not.toBe(svc.payloadHash('abc'));
  });

  it('MASTER_KEY 32 byte değilse başlatmada hata verir', () => {
    const config = { get: () => Buffer.from('kısa').toString('base64') };
    const bad = new CryptoService(config as unknown as ConfigService);
    expect(() => bad.onModuleInit()).toThrow(/32 byte/);
  });

  describe('AAD kayıt-id bağlama (v2)', () => {
    it('doğru aad ile çözer (round-trip)', () => {
      const aad = CryptoService.licenseItemAad('id-123');
      const enc = svc.encrypt('WIN10-KEY', aad);
      expect(enc.startsWith('v2.')).toBe(true);
      expect(svc.decrypt(enc, aad)).toBe('WIN10-KEY');
    });

    it('yanlış aad ile çözme patlar (satır-taşıma engeli)', () => {
      const enc = svc.encrypt('WIN10-KEY', CryptoService.licenseItemAad('id-A'));
      // Başka satırın id'siyle çözmeye çalışmak = ciphertext kopyalama saldırısı
      expect(() => svc.decrypt(enc, CryptoService.licenseItemAad('id-B'))).toThrow();
      // aad'siz de çözülemez
      expect(() => svc.decrypt(enc)).toThrow();
    });

    it('aad verilmezse v1 (geriye dönük) format üretir ve aad yok sayılır', () => {
      const enc = svc.encrypt('düz');
      expect(enc.startsWith('v1.')).toBe(true);
      // v1 kayıtta aad geçilse bile yok sayılır (eski veri kesintisiz çözülür)
      expect(svc.decrypt(enc, 'alakasız-aad')).toBe('düz');
      expect(svc.decrypt(enc)).toBe('düz');
    });

    it('licenseItemAad ve siteSecretAad ayrık namespace üretir', () => {
      expect(CryptoService.licenseItemAad('x')).not.toBe(CryptoService.siteSecretAad('x'));
    });

    /*
     * DENETİM BULGUSU — AAD kayıt-id'sini bağlıyordu ama KOLONU bağlamıyordu.
     *
     * `site_connect_tokens.{api_key_enc,hmac_secret_enc}` eskiden `sites.hmac_secret_enc` ile
     * AYNI AAD'yi (`site_secret:<siteId>`) kullanıyordu. Sonuç: DB'ye YAZMA erişimi olan ama
     * MASTER_KEY'i OLMAYAN biri, sitenin şifreli secret'ını kendi eklediği bir connect-token
     * satırına kopyalayıp kimliksiz PUBLIC `/v1/connect/claim` çağırabiliyor ve paneli o blob'u
     * çözüp DÜZ METİN döndürmeye ikna edebiliyordu (çözme oracle'ı).
     *
     * Bu test tam o taşımayı dener ve ÇÖZÜLEMEDİĞİNİ kilitler.
     */
    it('site secret blobu connect-token AAD ile ÇÖZÜLEMEZ (çözme oracle sınıfı kapalı)', () => {
      const siteId = 'site-1';
      const tokenId = 'token-1';
      const stolen = svc.encrypt('gercek-hmac-secret', CryptoService.siteSecretAad(siteId));

      // Saldırganın senaryosu: blob'u connect_token satırına taşı, claim'e çözdürt.
      expect(() => svc.decrypt(stolen, CryptoService.connectTokenAad(tokenId))).toThrow();

      // Ters yön de kapalı: token blob'u site secret gibi okunamaz.
      const tokenBlob = svc.encrypt('taze-hmac-secret', CryptoService.connectTokenAad(tokenId));
      expect(() => svc.decrypt(tokenBlob, CryptoService.siteSecretAad(siteId))).toThrow();

      // Aynı token id ile doğru çözülür (meşru yol bozulmadı).
      expect(svc.decrypt(tokenBlob, CryptoService.connectTokenAad(tokenId))).toBe(
        'taze-hmac-secret',
      );

      // Ad alanları üçü de ayrık.
      expect(CryptoService.connectTokenAad('x')).not.toBe(CryptoService.siteSecretAad('x'));
      expect(CryptoService.connectTokenAad('x')).not.toBe(CryptoService.licenseItemAad('x'));
    });
  });
});
