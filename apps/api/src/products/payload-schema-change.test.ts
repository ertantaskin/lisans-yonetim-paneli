import { describe, expect, it } from 'vitest';
import { payloadSchemaBreakingChange } from './products.service';

/**
 * Hesap ürünü payload şemasının GERİYE DÖNÜK yıkıcı değişimi (§11) — `products.update`
 * 409 guard'ının KARAR fonksiyonu (denetim Y2).
 *
 * NEDEN guard var: `parseAccountPayload` şemayı FİLTRE olarak kullanır; şifreli kanonik
 * JSON'da duran ama şemada bulunmayan anahtar sessizce düşer, `secret` bayrağı da maskeyi
 * o anda belirler. Bu yüzden alan KALDIRMA/YENİDEN ADLANDIRMA (veri kaybı + payload_hash
 * sapması ⇒ dedupe kırılması) ve `secret: true → false` (geriye dönük ifşa) mevcut stok
 * varken reddedilir.
 *
 * NEDEN guard DAR: alan EKLEME, `label` ve `required` değişimi meşru düzenlemelerdir —
 * yalnız YENİ kayıtları etkiler, eski kayıtları bozmaz (kapasite guard'ıyla aynı felsefe:
 * ürünü sonsuza dek kilitlemeyiz).
 */
const base = [
  { key: 'username', label: 'Kullanıcı', secret: false, required: true },
  { key: 'password', label: 'Parola', secret: true, required: true },
];

describe('products: payloadSchemaBreakingChange (şema guard karar fonksiyonu)', () => {
  it('alan EKLEMEK yıkıcı değildir (eski kayıtlar bozulmaz)', () => {
    const c = payloadSchemaBreakingChange(base, [
      ...base,
      { key: 'totp', label: '2FA', secret: true, required: false },
    ]);
    expect(c).toEqual({ removedKeys: [], unsecuredKeys: [], breaking: false });
  });

  it('label ve required değişimi serbesttir', () => {
    const c = payloadSchemaBreakingChange(base, [
      { key: 'username', label: 'E-posta / Kullanıcı adı', secret: false, required: false },
      { key: 'password', label: 'Şifre', secret: true, required: true },
    ]);
    expect(c.breaking).toBe(false);
  });

  it('alan KALDIRMAK yıkıcıdır (değer şifreli kalır ama hiçbir yüzeyde görünmez)', () => {
    const c = payloadSchemaBreakingChange(base, [base[1]!]);
    expect(c).toMatchObject({ removedKeys: ['username'], breaking: true });
  });

  it('YENİDEN ADLANDIRMA da kaldırma sayılır (yazım hatası düzeltmesi veri kaybettirir)', () => {
    // Gerçek senaryo: şemadaki 'usernme' yazım hatası 'username' diye düzeltilir → o şemayla
    // girilmiş TÜM kayıtlarda kullanıcı adı müşteri sayfasında/mailde/envanterde kaybolur.
    const typo = [{ key: 'usernme', label: 'Kullanıcı', secret: false, required: true }];
    const fixed = [{ key: 'username', label: 'Kullanıcı', secret: false, required: true }];
    const c = payloadSchemaBreakingChange(typo, fixed);
    expect(c).toMatchObject({ removedKeys: ['usernme'], breaking: true });
  });

  it('secret: true → false yıkıcıdır (GEÇMİŞ kayıtlarda parola düz görünmeye başlar)', () => {
    const c = payloadSchemaBreakingChange(base, [
      base[0]!,
      { key: 'password', label: 'Parola', secret: false, required: true },
    ]);
    expect(c).toMatchObject({ unsecuredKeys: ['password'], removedKeys: [], breaking: true });
  });

  it('secret: false → true serbesttir (gizliliği ARTIRMAK güvenli yön)', () => {
    const c = payloadSchemaBreakingChange(base, [
      { key: 'username', label: 'Kullanıcı', secret: true, required: true },
      base[1]!,
    ]);
    expect(c.breaking).toBe(false);
  });

  it('şemanın TAMAMEN kaldırılması (null) tüm alanların kaybı sayılır', () => {
    const c = payloadSchemaBreakingChange(base, null);
    expect(c).toMatchObject({ removedKeys: ['username', 'password'], breaking: true });
  });

  it('MEVCUT şema yok/bozuksa guard devreye girmez (operatör onarabilmeli)', () => {
    expect(payloadSchemaBreakingChange(null, base).breaking).toBe(false);
    expect(payloadSchemaBreakingChange({ bozuk: true }, base).breaking).toBe(false);
    // Boş dizi de geçerli bir şema DEĞİLDİR (AccountPayloadSchema min(1)) → onarım serbest.
    expect(payloadSchemaBreakingChange([], base).breaking).toBe(false);
  });

  it('aynı şema tekrar gönderilirse yıkıcı değildir (form her kaydetmede geri yollar)', () => {
    expect(payloadSchemaBreakingChange(base, base).breaking).toBe(false);
  });
});
