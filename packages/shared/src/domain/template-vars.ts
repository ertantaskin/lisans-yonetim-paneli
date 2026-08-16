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
   *
   * BİÇİM = GERÇEK ÇIKTI (mail.processor → formatValidUntil): gün.ay.yıl SAAT + saat dilimi.
   * Buradaki örnek daha önce saat gösteriyor ama gerçek mail YALNIZ GÜN yazıyordu; yani
   * şablon önizlemesi ile gönderilen mail ayrışmıştı — tam da bu dosyanın docstring'inde
   * uyarılan sapma sınıfı. Saat dilimi etiketi ŞART: aynı an, mağazanın diliminde FARKLI
   * GÜNE düşebiliyor (bkz. formatValidUntil gerekçesi).
   */
  valid_until: '01.09.2027 21:00 (UTC+03:00)',
  /**
   * Aynı bitişin HAM ISO 8601 (UTC) karşılığı — yoruma kapalı, makine-okunur.
   * Mağaza sayfası/.txt tarihi bu anlık değerden üretir → operatör şablonda ikisini yan yana
   * kullanarak mail ile müşteri sayfasının aynı anı gösterdiğini kanıtlayabilir.
   */
  valid_until_iso: '2027-09-01T18:00:00.000Z',
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

/**
 * `{{degisken}}` token kalıbı — TEK KAYNAK.
 *
 * NEDEN BURADA: aynı kalıp ÜÇ yerde ayrı ayrı yazılıydı (`mail/templates.service.render`,
 * `templates/templates.service.renderTemplate|usedTemplateVars`, admin şablon editörü).
 * Bu dosyanın kendi docstring'i tam olarak bu sapmanın hikâyesini anlatıyor: değişken
 * LİSTESİ iki yerde tutulduğu için ayrışmış ve panel aynı token'a iki farklı cevap
 * vermişti. Kalıbın kendisi de aynı riski taşır — biri `\w+` yazıp diğeri `[a-z_]+`
 * yazsaydı, editörün "desteklenmiyor" uyarısı ile gönderimde GERÇEKTEN değişen token
 * kümesi ayrışır ve müşteriye ham `{{...}}` giderdi.
 *
 * Global (`g`) bayrağı ŞART (`matchAll` non-global regex'te TypeError atar; `replace`
 * tüm tekrarları değiştirsin diye gerekli). `.test()` ile KULLANMAYIN — global regex'te
 * `lastIndex` durumu taşınır ve ardışık çağrılar dönüşümlü olarak false döner.
 */
export const TEMPLATE_TOKEN_RE = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * `{{degisken}}` token değişimi (§6). Sözlükte OLMAYAN token SESSİZCE '' olur —
 * bu bilinçli (mail asla ham `{{...}}` göstermez); operatör uyarısı `extractTemplateVars`
 * + `DELIVERY_TEMPLATE_TOKENS` farkından üretilir.
 */
export function renderTemplateVars(template: string, vars: Record<string, string>): string {
  return template.replace(TEMPLATE_TOKEN_RE, (_, k: string) => vars[k] ?? '');
}

/** Şablonda kullanılan BENZERSİZ token adları (uyarı/doğrulama için; sıra: ilk görülme). */
export function extractTemplateVars(template: string): string[] {
  const set = new Set<string>();
  for (const m of template.matchAll(TEMPLATE_TOKEN_RE)) {
    if (m[1]) set.add(m[1]);
  }
  return [...set];
}
