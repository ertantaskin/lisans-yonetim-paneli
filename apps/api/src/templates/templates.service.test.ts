import { describe, expect, it } from 'vitest';
import { renderTemplate, usedTemplateVars, SAMPLE_VARS } from './templates.service';

/**
 * #18 — mail şablonu desteklenmeyen değişken tespiti (§6). renderTemplate bilinmeyen
 * {{degisken}}'i sessizce '' yapar; usedTemplateVars + SAMPLE_VARS farkı bunu yüzeye çıkarır
 * (admin {{password}} yazınca boş render'ı fark etsin — sessiz veri kaybını önle).
 */
describe('templates: usedTemplateVars + desteklenmeyen değişken tespiti (#18)', () => {
  it('kullanılan {{degisken}} adlarını BENZERSİZ çıkarır (boşluk toleranslı)', () => {
    const vars = usedTemplateVars('Merhaba {{order_no}}, {{ items }} ve tekrar {{order_no}} {{password}}');
    expect([...vars].sort()).toEqual(['items', 'order_no', 'password']);
  });

  it('desteklenen set (SAMPLE_VARS) dışındaki değişkenler yakalanır', () => {
    const known = new Set(Object.keys(SAMPLE_VARS));
    const unknown = usedTemplateVars('{{order_no}} {{password}} {{key}} {{items}}').filter(
      (v) => !known.has(v),
    );
    expect(unknown.sort()).toEqual(['key', 'password']);
  });

  it('render bilinen değişkeni doldurur, bilinmeyeni BOŞ yapar (sessiz kayıp kanıtı)', () => {
    expect(renderTemplate('{{order_no}}|{{password}}', SAMPLE_VARS)).toBe('10042|');
  });
});
