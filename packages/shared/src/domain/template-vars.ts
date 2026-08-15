/**
 * Teslimat maili şablon değişkenleri (§6) — TEK KAYNAK.
 *
 * NEDEN PAYLAŞILAN PAKETTE (ölçülmüş sapma): bu sözlük hem "önizleme örnek değerleri" hem de
 * "DESTEKLENEN değişkenler listesi" olarak kullanılıyor — şablon editörü, burada olmayan bir
 * token'ı operatöre "desteklenmiyor, gönderimde boş çıkar" diye uyarıyor.
 *
 * Liste API'de (`templates.service`) ve admin editöründe (`template-editor.tsx`) AYRI AYRI
 * yazılmıştı ve ayrışmıştı: API `valid_until` besliyor, editörün kopyasında o alan YOKTU →
 * `{{valid_until}}` yazan operatör YANLIŞ bir uyarı görüyor, üstelik aynı panelin sunucu
 * taraflı önizlemesi (`templates.preview → unknownVars`) onu geçerli sayıyordu. İki cevap,
 * tek ekran. Artık iki taraf da buradan okur; yeni bir değişken eklendiğinde uyarı listesi
 * kendiliğinden doğru kalır.
 *
 * DEĞİŞKEN EKLERKEN: mail.processor'da `vars` nesnesine gerçekten beslediğinizden emin olun —
 * bu sözlük "besleniyor" iddiasıdır, beslemeyi kendisi yapmaz.
 */
export const DELIVERY_TEMPLATE_SAMPLE_VARS: Record<string, string> = {
  order_no: '10042',
  site_name: 'ornek-site.com',
  product_name: 'Windows 11 Pro',
  units: '1',
  customer_email: 'musteri@ornek.com',
  items: '• Windows 11 Pro: XXXXX-XXXXX-XXXXX-XXXXX-XXXXX',
  /**
   * Süreli hesap ürünlerinde lisansın bitiş tarihi (siparişteki EN YAKIN bitiş).
   * Süresiz üründe boş kalır.
   */
  valid_until: '01.09.2027 21:00',
  /**
   * §7 kurulum/etkinleştirme rehberi bloğu — ürüne bağlı talimat metni (product_guides).
   * Şablonda YOKSA blok mailin SONUNA eklenir (mail.processor → withGuides): mevcut
   * şablonlar bu token'ı içermediği için rehber sessizce kaybolmasın. Token'ı yazmak
   * yalnız KONUMU seçmeye yarar.
   */
  guides:
    '── Office 365 kurulum ve etkinleştirme ──\n1. https://www.office.com adresinden Oturum Aç deyin.\n2. Size gönderilen geçici şifreyle giriş yapın ve şifrenizi güncelleyin.',
};

/** Şablonda kullanılabilecek değişken ADLARI (editörün uyarı listesi bundan türetilir). */
export const DELIVERY_TEMPLATE_TOKENS = Object.keys(DELIVERY_TEMPLATE_SAMPLE_VARS);
