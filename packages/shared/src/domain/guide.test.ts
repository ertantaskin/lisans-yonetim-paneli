import { describe, expect, it } from 'vitest';
import {
  GUIDE_MAIL_MAX_GUIDES,
  GUIDE_MAIL_TOTAL_MAX,
  buildGuideMailBlock,
  renderGuideHtml,
  renderGuideText,
} from './guide';

/**
 * Rehber render'ı MÜŞTERİ TARAYICISINDA çalışır (mağaza sipariş sayfası) → XSS yüzeyi.
 * Metni panel yöneticisi yazar ama owner OLMAYAN admin de yazabilir (§8 rol ayrımı),
 * dolayısıyla "içeriği biz yazıyoruz, güvenli" varsayımı geçerli DEĞİLDİR.
 */
describe('renderGuideHtml — güvenlik', () => {
  it('ham HTML etiketleri KAÇIRILIR (çalıştırılmaz)', () => {
    const html = renderGuideHtml('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('olay öznitelikli etiket denemesi de metne dönüşür', () => {
    const html = renderGuideHtml('<img src=x onerror=alert(1)>');
    // ÖNEMLİ OLAN: canlı etiket üretilmemesi. "onerror" kelimesi kaçırılmış METİN olarak
    // görünebilir (&lt;img …&gt;) — bu zararsızdır ve onu yasaklamak yanlış bir iddiadır.
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('javascript: şeması bağlantıya ÇEVRİLMEZ (yalnız http/https)', () => {
    const html = renderGuideHtml('javascript:alert(1) adresine gidin');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href');
  });

  it('tırnak ve & karakterleri öznitelik kaçışını kıramaz', () => {
    const html = renderGuideHtml('Parola: a"b\'c & d');
    expect(html).toContain('&quot;');
    expect(html).toContain('&#39;');
    expect(html).toContain('&amp;');
  });
});

describe('renderGuideHtml — biçimleme', () => {
  it('numaralı satırlar sıralı listeye dönüşür', () => {
    const html = renderGuideHtml('1. Giriş yapın\n2. Şifreyi değiştirin');
    expect(html).toBe('<ol><li>Giriş yapın</li><li>Şifreyi değiştirin</li></ol>');
  });

  /**
   * REGRESYON: adımlar arasına boş satır koymak (çok doğal bir yazım) her adımı ayrı bir
   * <ol> yapıyordu ve HTML numarayı 1'den yeniden başlatıyordu → müşteri "1. 1. 1." görürdü,
   * üstelik aynı metnin DÜZ METİN sürümü (e-posta) doğru numaraları gösteriyordu. İki yüzey
   * sessizce ayrışıyordu.
   */
  it('adımlar arasında boş satır varsa numaralandırma DEVAM eder', () => {
    const html = renderGuideHtml('1. Giriş yapın\n\n2. Şifreyi değiştirin\n\n3. Kurulumu indirin');
    expect(html).toBe(
      '<ol><li>Giriş yapın</li></ol>' +
        '<ol start="2"><li>Şifreyi değiştirin</li></ol>' +
        '<ol start="3"><li>Kurulumu indirin</li></ol>',
    );
  });

  it('1 ile başlayan listede gereksiz start özniteliği basılmaz', () => {
    expect(renderGuideHtml('1. Tek adım')).toBe('<ol><li>Tek adım</li></ol>');
  });

  it('tire ile başlayan satırlar madde listesine dönüşür', () => {
    expect(renderGuideHtml('- Word\n- Excel')).toBe('<ul><li>Word</li><li>Excel</li></ul>');
  });

  it('boş satır blokları ayırır; blok içi satır sonu <br> olur', () => {
    const html = renderGuideHtml('Birinci satır\nİkinci satır\n\nYeni paragraf');
    expect(html).toBe('<p>Birinci satır<br>İkinci satır</p><p>Yeni paragraf</p>');
  });

  it('## başlık h4 üretir (sayfadaki h2 altında seviye atlamaz)', () => {
    expect(renderGuideHtml('## Kurulum')).toBe('<h4>Kurulum</h4>');
  });

  it('**kalın** vurguya dönüşür', () => {
    expect(renderGuideHtml('**Şifrenizi not alın**')).toBe(
      '<p><strong>Şifrenizi not alın</strong></p>',
    );
  });

  it('http(s) adresi bağlantı olur, sondaki noktalama bağlantıya GİRMEZ', () => {
    const html = renderGuideHtml('https://www.office.com adresine gidin.');
    expect(html).toContain('href="https://www.office.com"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    // Cümle sonundaki nokta bağlantının içinde kalırsa adres 404 verir.
    const withDot = renderGuideHtml('Adres: https://www.office.com.');
    expect(withDot).toContain('href="https://www.office.com"');
    expect(withDot).toContain('</a>.');
  });

  it('şemasız alan adı bağlantıya ÇEVRİLMEZ (tahmin yok)', () => {
    expect(renderGuideHtml('office.com adresinden giriş yapın')).not.toContain('<a ');
  });

  it('boş gövde boş string döner (yer tutucu etiket üretmez)', () => {
    expect(renderGuideHtml('   \n\n  ')).toBe('');
  });

  it('CRLF satır sonları LF gibi işlenir (Windows yapıştırması)', () => {
    expect(renderGuideHtml('1. Bir\r\n2. İki')).toBe('<ol><li>Bir</li><li>İki</li></ol>');
  });
});

describe('renderGuideText — düz metin', () => {
  it('biçimleme işaretleri temizlenir, yapı korunur', () => {
    expect(renderGuideText('## Kurulum\n1. **Giriş** yapın')).toBe('Kurulum\n1. Giriş yapın');
  });

  it('üç ve daha fazla boş satır ikiye iner', () => {
    expect(renderGuideText('A\n\n\n\nB')).toBe('A\n\nB');
  });
});

describe('buildGuideMailBlock — adet ve boyut tavanı', () => {
  const guide = (id: string, body = 'İçerik') => ({ id, title: `Rehber ${id}`, body });

  it('rehber yoksa boş blok döner', () => {
    expect(buildGuideMailBlock([])).toEqual({ text: '', included: 0, omitted: 0 });
  });

  it('adet tavanı aşılınca KIRPMA GÖRÜNÜR olur (sessiz düşürme yok)', () => {
    const many = Array.from({ length: GUIDE_MAIL_MAX_GUIDES + 2 }, (_, i) => guide(String(i)));
    const block = buildGuideMailBlock(many);
    expect(block.included).toBe(GUIDE_MAIL_MAX_GUIDES);
    expect(block.omitted).toBe(2);
    expect(block.text).toContain('sipariş sayfanızdan');
  });

  it('boyut tavanı aşılınca sonraki rehber eklenmez', () => {
    const big = 'x'.repeat(GUIDE_MAIL_TOTAL_MAX - 10);
    const block = buildGuideMailBlock([guide('a', big), guide('b', big)]);
    expect(block.included).toBe(1);
    expect(block.omitted).toBe(1);
  });

  it('TEK rehber tavandan büyük olsa bile eklenir (aksi halde mail rehbersiz giderdi)', () => {
    const huge = 'x'.repeat(GUIDE_MAIL_TOTAL_MAX + 1000);
    const block = buildGuideMailBlock([guide('a', huge)]);
    expect(block.included).toBe(1);
    expect(block.omitted).toBe(0);
  });

  it('gövdesi boş rehber sayılmaz', () => {
    const block = buildGuideMailBlock([guide('a', '   ')]);
    expect(block.included).toBe(0);
    expect(block.omitted).toBe(1);
  });
});
