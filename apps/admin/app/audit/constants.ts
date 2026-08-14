/**
 * Denetim izi ekranının PAYLAŞILAN sabitleri (§8).
 *
 * NEDEN AYRI DOSYA: `actions.ts` `'use server'` taşır ve Next 15'te oradan YALNIZ async
 * fonksiyon export edilebilir → süzgeç listeleri orada duramaz. Sunucu aksiyonu (girdi
 * doğrulaması) ile istemci tablosu (açılır liste seçenekleri) AYNI listeyi kullanmak zorunda;
 * iki kopya tutmak sessiz sapma üretirdi ("UI'da seçilebilen değer API'de 400 alır").
 */

/**
 * `audit_action` PG enum'unun tam listesi (apps/api/src/db/schema/enums.ts).
 * Türkçe karşılıkları `lib/labels.ts` → `auditActionLabel` (TEK KAYNAK, zaten mevcut).
 */
export const AUDIT_ACTIONS = [
  'reveal',
  'replace',
  'revoke',
  'suspend',
  'unsuspend',
  'import',
  'login',
  'assign',
  'resend',
  'site_update',
  'anonymize',
  'receive',
  'recall',
  'adjust',
] as const;

/** API'nin kabul ettiği sayfa boyutları (audit.service `AUDIT_PAGE_SIZES` ile birebir). */
export const AUDIT_PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_AUDIT_PAGE_SIZE = 50;

/**
 * Hedef türü etiketleri TEK KAYNAKTAN (`lib/labels.ts`) gelir — bu dosyada YEREL bir sözlük
 * tutmak, ham `license_item_list` gibi değerlerin bir ekranda Türkçe diğerinde ham çıkmasına
 * yol açardı (projede tekrarlayan hata sınıfı). Buradan yalnız yeniden export edilir ki
 * ekranın import yüzeyi değişmesin.
 */
export { auditTargetTypeLabel as targetTypeLabel, AUDIT_TARGET_TYPE_OPTIONS as TARGET_TYPE_OPTIONS } from '../../lib/labels';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): boolean => typeof v === 'string' && UUID_RE.test(v);

/**
 * Denetim satırının hedefine DERİN BAĞLANTI — yalnız GERÇEKTEN VAR OLAN detay rotaları için.
 *
 * KURAL (projede yerleşik: "ya doğru olmalı ya hiç link olmamalı"): var olmayan bir sayfaya
 * link basmak operatörü 404'e götürür ve ekranın güvenilirliğini düşürür. Bu yüzden:
 *  · `assignment` / `license_item` → panelde tekil detay sayfası YOK → link YOK.
 *  · `customer` → `anonymize` kaydının hedefi KVKK gereği MASKELİ e-postadır (gerçek adres
 *    değil) → link kurulamaz.
 *  · `order_line` → satırın kendi sayfası yok; ama meta'da `orderId` var → siparişe gider.
 *  · `license_item_list` → hedef, listenin kapsamı olan ÜRÜN id'sidir ('all' olabilir).
 */
export function auditTargetHref(
  targetType: string | null,
  targetId: string | null,
  meta: unknown,
): string | null {
  const metaObj = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null;
  const id = targetId ?? '';

  switch (targetType) {
    case 'order':
      return isUuid(id) ? `/orders/${id}` : null;
    case 'order_line': {
      const orderId = metaObj?.orderId;
      return isUuid(orderId) ? `/orders/${String(orderId)}` : null;
    }
    case 'product':
      return isUuid(id) ? `/products/${id}` : null;
    case 'license_item_list':
      // targetId = kapsanan ürün ('all' ise global liste görüntülemesi → link yok).
      return isUuid(id) ? `/products/${id}` : null;
    case 'site':
      return isUuid(id) ? `/sites/${id}` : null;
    case 'supplier':
      return isUuid(id) ? `/suppliers/${id}` : null;
    case 'batch':
      return isUuid(id) ? `/batches/${id}` : null;
    case 'purchase_order':
      return isUuid(id) ? `/purchase-orders/${id}` : null;
    case 'supplier_claim':
      return isUuid(id) ? `/quarantine/claims/${id}` : null;
    case 'quarantine':
      return '/quarantine';
    default:
      return null;
  }
}
