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
  });
});
