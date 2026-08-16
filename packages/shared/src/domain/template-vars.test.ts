import { describe, expect, it } from 'vitest';
import {
  DELIVERY_TEMPLATE_SAMPLE_VARS,
  DELIVERY_TEMPLATE_TOKENS,
  extractTemplateVars,
  renderTemplateVars,
} from './template-vars';

/**
 * Şablon token'ı TEK KAYNAK (§6).
 *
 * Bu dosyanın asıl işi, kalıbı paylaşılan pakete taşırken doğan YENİ arıza modunu
 * kilitlemek: kalıp artık PAYLAŞILAN ve GLOBAL (`g`) bir RegExp NESNESİDİR. Global
 * regex'ler `lastIndex` durumu taşır — aynı nesne iki çağrı arasında durumu sızdırsaydı
 * ikinci çağrı sessizce EKSİK sonuç verirdi (render yolunda bu, müşteriye ham `{{...}}`
 * gitmesi demektir). `matchAll` regex'i klonlar, `replace` `lastIndex`'i sıfırlar; bu
 * testler o davranışa GÜVENDİĞİMİZİ açıkça yazar.
 */
describe('template-vars: paylaşılan {{token}} kalıbı', () => {
  it('token değiştirir; sözlükte olmayanı SESSİZCE boşaltır (mail ham {{...}} göstermez)', () => {
    expect(renderTemplateVars('{{order_no}}|{{ items }}|{{yok}}', { order_no: '1', items: 'x' })).toBe(
      '1|x|',
    );
  });

  it('boşluklu ve tekrarlı token adlarını benzersizleştirir', () => {
    expect(extractTemplateVars('{{a}} {{ a }} {{b}}')).toEqual(['a', 'b']);
  });

  it('AYNI girdiyle ardışık çağrılar AYNI sonucu verir (global regex lastIndex sızıntısı yok)', () => {
    const tpl = '{{order_no}} {{items}} {{order_no}}';
    expect(extractTemplateVars(tpl)).toEqual(extractTemplateVars(tpl));
    expect(renderTemplateVars(tpl, { order_no: 'A', items: 'B' })).toBe(
      renderTemplateVars(tpl, { order_no: 'A', items: 'B' }),
    );
    // Karışık sıra: render sonrası extract, extract sonrası render de bozulmamalı.
    renderTemplateVars(tpl, {});
    expect(extractTemplateVars(tpl)).toEqual(['order_no', 'items']);
  });

  it('DESTEKLENEN token listesi örnek sözlükle birebir aynı kümedir', () => {
    // Editörün "desteklenmiyor" uyarısı bu farktan üretilir; iki kaynak ayrışırsa
    // geçerli bir token'a yanlış uyarı çıkar (bu dosyanın doğuş sebebi).
    expect(new Set(DELIVERY_TEMPLATE_TOKENS)).toEqual(
      new Set(Object.keys(DELIVERY_TEMPLATE_SAMPLE_VARS)),
    );
    expect(extractTemplateVars('{{order_no}} {{password}}').filter(
      (v) => !DELIVERY_TEMPLATE_TOKENS.includes(v),
    )).toEqual(['password']);
  });
});
