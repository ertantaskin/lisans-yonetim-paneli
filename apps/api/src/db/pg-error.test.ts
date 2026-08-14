import { describe, expect, it } from 'vitest';
import { isForeignKeyViolation, isUniqueViolation, pgErrorCode } from './pg-error';

/**
 * REGRESYON KİLİDİ — drizzle-orm 0.45 sürücü hatalarını `DrizzleQueryError` içine SARAR
 * ve orijinal hatayı `cause` zincirine koyar. Yükseltme sırasında kod tabanındaki iki
 * kırılgan desen (`e.code === '23505'` ve `String(e).includes('unique')`) SESSİZCE devre
 * dışı kaldı: "bu ad zaten var" (409) demesi gereken yollar ham 500 dönmeye başladı
 * (kategori ikizi, admin e-posta/kullanıcı adı, site-ürün eşlemesi). Tip denetimi bunu
 * GÖREMEZ; entegrasyon testi yakaladı. Bu dosya, kod okumanın sarmalanmış hatada da
 * çalıştığını DB gerektirmeden kilitler.
 */
describe('pgErrorCode — SQLSTATE hata zincirinden okunur', () => {
  it('düz sürücü hatasında kodu okur', () => {
    expect(pgErrorCode(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe('23505');
  });

  it('SARMALANMIŞ hatada (drizzle 0.45 deseni) cause zincirinden okur', () => {
    const driver = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    const wrapped = Object.assign(new Error('Failed query: insert into "product_categories" …'), {
      cause: driver,
    });
    expect(pgErrorCode(wrapped)).toBe('23505');
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it('iki kat sarmalamada da bulur', () => {
    const driver = Object.assign(new Error('fk'), { code: '23503' });
    const wrapped = new Error('katman 1', { cause: new Error('katman 2', { cause: driver }) });
    expect(isForeignKeyViolation(wrapped)).toBe(true);
  });

  it('kodu olmayan hatada null döner ve unique DEĞİL sayılır', () => {
    expect(pgErrorCode(new Error('ağ hatası'))).toBeNull();
    expect(isUniqueViolation(new Error('ağ hatası'))).toBe(false);
  });

  it('metin yedeği: kod okunamıyorsa constraint metnine düşer (sessiz 500 yerine 409)', () => {
    expect(isUniqueViolation(new Error('duplicate key value violates unique constraint "x"'))).toBe(
      true,
    );
  });

  it('BAŞKA bir SQLSTATE unique sayılmaz (yanlış-pozitif yok)', () => {
    expect(isUniqueViolation(Object.assign(new Error('fk'), { code: '23503' }))).toBe(false);
  });

  it('döngüsel cause zincirinde sonsuz döngüye girmez', () => {
    const a: { cause?: unknown } = {};
    const b = { cause: a };
    a.cause = b;
    expect(pgErrorCode(a)).toBeNull();
  });

  it('null/undefined güvenli', () => {
    expect(pgErrorCode(null)).toBeNull();
    expect(pgErrorCode(undefined)).toBeNull();
    expect(isUniqueViolation(null)).toBe(false);
  });
});
