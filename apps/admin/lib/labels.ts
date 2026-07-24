/**
 * Türkçe etiket sözlüğü — enum/kod değerlerini operatöre gösterilecek Türkçe metne çevirir.
 * TEK KAYNAK: ham enum (`partial-auto`, `voided`, `MAK`…) kullanıcıya asla çıplak gösterilmez.
 * Tüm admin ekranları buradan okur → tutarlılık. Bilinmeyen anahtar → ham değer (regresyonsuz geri düşüş).
 */

function lookup(map: Record<string, string>, key: string | null | undefined): string {
  if (key == null) return '';
  return map[key] ?? key;
}

// ── Ürün ───────────────────────────────────────────────────────────────────
const PRODUCT_KIND: Record<string, string> = {
  key: 'Lisans anahtarı',
  account: 'Hesap',
  code: 'Kod / hediye çeki',
  custom: 'Özel',
};
export const productKindLabel = (k: string) => lookup(PRODUCT_KIND, k);

const USAGE_MODE: Record<string, string> = {
  single: 'Tek kullanımlık',
  multi: 'Çok kullanımlık (MAK)',
};
export const usageModeLabel = (m: string) => lookup(USAGE_MODE, m);

const FULFILLMENT_POLICY: Record<string, string> = {
  'partial-auto': 'Kısmi — otomatik',
  'partial-approval': 'Kısmi — onaylı',
  'all-or-nothing': 'Ya hep ya hiç',
};
export const fulfillmentPolicyLabel = (p: string) => lookup(FULFILLMENT_POLICY, p);

const ON_EXPIRY: Record<string, string> = {
  hide: 'Erişimi gizle',
  keep: 'Erişimi koru',
};
export const onExpiryLabel = (v: string) => lookup(ON_EXPIRY, v);

/** Ürün tip özeti (products-table + detay başlığı ortak dili): tip · MAK×N · Ng. */
export function productTypeSummary(p: {
  kind: string;
  usageMode?: string | null;
  maxUses?: number | null;
  validityDays?: number | null;
}): string {
  const parts: string[] = [productKindLabel(p.kind)];
  if (p.usageMode === 'multi') parts.push(`MAK×${p.maxUses ?? '?'}`);
  if (p.validityDays) parts.push(`${p.validityDays} gün`);
  return parts.join(' · ');
}

// ── Stok durumu (StatTile kırılımı) ──────────────────────────────────────────
const STOCK_STATE: Record<string, string> = {
  available: 'Kullanılabilir',
  assigned: 'Teslim edilen',
  revoked: 'Geri alınan',
  expired: 'Süresi dolan',
  voided: 'Geçersiz',
};
export const stockStateLabel = (s: string) => lookup(STOCK_STATE, s);

// ── Parti / Satın alma emri durumu ──────────────────────────────────────────
const SUPPLY_STATUS: Record<string, string> = {
  active: 'Aktif',
  received: 'Teslim alındı',
  ordered: 'Sipariş verildi',
  partial: 'Kısmi',
  draft: 'Taslak',
  recalled: 'Geri çekildi',
  voided: 'Geçersiz',
  cancelled: 'İptal',
  canceled: 'İptal',
};
export const supplyStatusLabel = (s: string) => lookup(SUPPLY_STATUS, s);

// ── Stok düzeltme işlemi ─────────────────────────────────────────────────────
const ADJUSTMENT_ACTION: Record<string, string> = {
  correct: 'Düzeltme',
  void: 'Geçersiz kıl',
  damage: 'Hasarlı',
  recall: 'Geri çekme',
};
export const adjustmentActionLabel = (a: string) => lookup(ADJUSTMENT_ACTION, a);

// ── Sipariş / atama durumu ───────────────────────────────────────────────────
const ORDER_STATUS: Record<string, string> = {
  pending: 'Bekliyor',
  partial: 'Kısmi teslim',
  fulfilled: 'Tamamlandı',
  held_for_review: 'İncelemede',
  revoked: 'Geri alındı',
  canceled: 'İptal',
  cancelled: 'İptal',
};
export const orderStatusLabel = (s: string) => lookup(ORDER_STATUS, s);

const ASSIGNMENT_STATUS: Record<string, string> = {
  active: 'Aktif',
  delivered: 'Teslim edildi',
  suspended: 'Askıda',
  revoked: 'Geri alındı',
  expired: 'Süresi doldu',
};
export const assignmentStatusLabel = (s: string) => lookup(ASSIGNMENT_STATUS, s);

// ── Zaman çizelgesi olay tipi ────────────────────────────────────────────────
// Anahtarlar GERÇEK `fulfillment_events.type` değerleridir (kaynak: apps/api/src/orders/
// {orders,admin-orders,fulfillment}.service.ts — sipariş detayı bu tabloyu ham döndürür).
// Bilinmeyen anahtar → ham değer (regresyonsuz geri düşüş); hedef: hiçbir ham snake_case
// string (ör. `assignment_created`) operatöre çıplak görünmesin.
const EVENT_TYPE: Record<string, string> = {
  order_received: 'Sipariş alındı',
  held_for_review: 'İncelemeye alındı',
  fulfilled: 'Sipariş tamamlandı',
  partially_fulfilled: 'Kısmi teslim edildi',
  pending_stock: 'Stok bekleniyor',
  line_completed: 'Satır tamamlandı',
  order_edited: 'Sipariş güncellendi',
  revoked: 'Geri alındı',
  review_released: 'İnceleme onaylandı',
  review_rejected: 'İnceleme reddedildi',
};
export const eventTypeLabel = (t: string) => lookup(EVENT_TYPE, t);
