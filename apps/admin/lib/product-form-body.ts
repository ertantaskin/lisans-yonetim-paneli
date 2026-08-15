/**
 * Ürün formu (`components/product-create-form.tsx`) → API gövdesi dönüşümü.
 *
 * NEDEN AYRI DOSYA: bu fonksiyon `app/stock/actions.ts` içinde, yani bir `'use server'`
 * dosyasında yaşıyordu. Orada bir yardımcıyı DIŞA AKTARMAK yasak (Next yalnız async
 * fonksiyon export'una izin verir, `check-use-server.js` bunu zorlar) → fonksiyon test
 * EDİLEMİYORDU. Sonucu şuydu: form `<select name="guideId">` alanını basıyordu ama gövde
 * kurucusu onu HİÇ okumuyordu; operatör kurulum rehberini seçip kaydediyor, ekran yeşil
 * sonuç veriyor, `products.guide_id` NULL kalıyor ve rehber müşteri sayfasında/mailde
 * HİÇ görünmüyordu. Hiçbir tip hatası, hiçbir kırmızı test yoktu — çünkü bu kodun testi
 * olamıyordu. Modül dışarı taşındı ve her form alanının gövdeye ULAŞTIĞI testle kilitlendi
 * (`product-form-body.test.ts`); yeni bir alan eklenip burada okunmazsa test düşer.
 *
 * KURAL (opsiyonel alanlar):
 *   · create (`isUpdate=false`): boş kalan opsiyonel alan gövdeye HİÇ eklenmez → DB default null.
 *   · update (`isUpdate=true`): opsiyonel alan HER ZAMAN gönderilir — değer varsa değer, boşsa
 *     açık `null`. Aksi halde bir alanı TEMİZLEMEK imkânsız olurdu (API `.partial()` kullanır,
 *     gönderilmeyen alanı "değişmedi" sayar → eski değer inatla kalırdı).
 */

/** Formda `name="..."` ile basılan TÜM alanlar. Test bu listeyi gövdeye karşı doğrular. */
export const PRODUCT_FORM_FIELDS = [
  'sku',
  'name',
  'kind',
  'usageMode',
  'fulfillmentPolicy',
  'onExpiry',
  'stockless',
  'maxUses',
  'categoryId',
  'guideId',
  'validityDays',
  'warrantyDays',
  'lowStockThreshold',
  'releaseAt',
  'keyFormat',
  'payloadSchema',
] as const;

export function buildProductBody(formData: FormData, isUpdate = false): Record<string, unknown> {
  const kind = String(formData.get('kind') || 'key');
  const usageMode = String(formData.get('usageMode') || 'single');
  const num = (k: string): number | undefined => {
    const v = String(formData.get(k) || '').trim();
    return v ? Number(v) : undefined;
  };

  const body: Record<string, unknown> = {
    sku: String(formData.get('sku') || '').trim(),
    name: String(formData.get('name') || '').trim(),
    kind,
    usageMode,
    fulfillmentPolicy: String(formData.get('fulfillmentPolicy') || 'partial-auto'),
    onExpiry: String(formData.get('onExpiry') || 'hide'),
    // checkbox: işaretliyse 'on', değilse yok → boolean'a normalize et.
    stockless: formData.get('stockless') != null,
  };
  if (usageMode === 'multi') body.maxUses = num('maxUses');

  // Kategori (§17): boş seçenek = "Kategorisiz".
  const categoryId = String(formData.get('categoryId') || '').trim();
  if (isUpdate) body.categoryId = categoryId || null;
  else if (categoryId) body.categoryId = categoryId;

  // Kurulum rehberi: kategoriyle BİREBİR aynı kural (boş seçenek = "Rehber gönderme").
  const guideId = String(formData.get('guideId') || '').trim();
  if (isUpdate) body.guideId = guideId || null;
  else if (guideId) body.guideId = guideId;

  const validityDays = num('validityDays');
  const warrantyDays = num('warrantyDays');
  const lowStockThreshold = num('lowStockThreshold');
  // releaseAt: <input type="datetime-local"> → ISO'ya çevir (API .datetime() ister).
  const releaseAtRaw = String(formData.get('releaseAt') || '').trim();
  let releaseAtIso: string | undefined;
  if (releaseAtRaw) {
    const d = new Date(releaseAtRaw);
    if (!Number.isNaN(d.getTime())) releaseAtIso = d.toISOString();
  }
  const keyFormat = String(formData.get('keyFormat') || '').trim();

  if (isUpdate) {
    // Update: boş = açık null (temizle); değer varsa gönder. lowStock 0 geçerli değerdir.
    body.validityDays = validityDays ?? null;
    body.warrantyDays = warrantyDays ?? null;
    body.lowStockThreshold = lowStockThreshold ?? null;
    body.releaseAt = releaseAtIso ?? null;
    body.keyFormat = keyFormat || null;
  } else {
    // Create: boş = atla (DB default null).
    if (validityDays) body.validityDays = validityDays;
    if (warrantyDays !== undefined) body.warrantyDays = warrantyDays;
    // lowStockThreshold: boş = uyarı KAPALI (body'ye ekleme); 0 dahil geçerli değerdir.
    if (lowStockThreshold !== undefined) body.lowStockThreshold = lowStockThreshold;
    if (releaseAtIso) body.releaseAt = releaseAtIso;
    if (keyFormat) body.keyFormat = keyFormat;
  }
  // account: payloadSchema client'ta JSON'a serialize edilmiş — parse edip iletiriz.
  if (kind === 'account') {
    const raw = String(formData.get('payloadSchema') || '');
    if (raw) {
      try {
        body.payloadSchema = JSON.parse(raw);
      } catch {
        /* boş bırak — API refine reddeder, kullanıcı düzeltir */
      }
    }
  }
  return body;
}
