import { z } from 'zod';

/**
 * Alan enum'ları — MIMARI.md ile birebir. Bu dosya tüm sistemin (API + admin +
 * eklenti sözleşmesi) tek doğruluk kaynağıdır. Statü ekler/çıkarırken önce
 * docs/MIMARI.md'ye bakın.
 */

// ── Site / kanal (§3, §10) ──────────────────────────────────────────────────
export const SiteType = z.enum(['woocommerce', 'marketplace', 'reseller']);
export type SiteType = z.infer<typeof SiteType>;

// ── Ürün (§3, §11) ──────────────────────────────────────────────────────────
export const ProductKind = z.enum(['key', 'account', 'custom', 'code']);
export type ProductKind = z.infer<typeof ProductKind>;

/** single = tek kullanımlık key; multi = çok kullanımlık (MAK, 1 key = N satış). */
export const UsageMode = z.enum(['single', 'multi']);
export type UsageMode = z.infer<typeof UsageMode>;

/** Kısmi teslimat politikası (§5). Ürün bazlı, sipariş override edilebilir. */
export const FulfillmentPolicy = z.enum(['partial-auto', 'partial-approval', 'all-or-nothing']);
export type FulfillmentPolicy = z.infer<typeof FulfillmentPolicy>;

/** Süreli üründe süre bitince davranış (§11). */
export const OnExpiry = z.enum(['hide', 'keep']);
export type OnExpiry = z.infer<typeof OnExpiry>;

// ── Lisans yaşam döngüsü (§2) ───────────────────────────────────────────────
// available → assigned → (suspended ⇄ assigned) | replaced | revoked
// revoked → quarantined → (admin onayıyla available | imha)
// çok kullanımlıkta dolunca depleted; süreli üründe expired; recall'da voided
export const LicenseItemStatus = z.enum([
  'available',
  'assigned',
  'suspended',
  'replaced',
  'revoked',
  'quarantined',
  'depleted',
  'expired',
  'voided',
]);
export type LicenseItemStatus = z.infer<typeof LicenseItemStatus>;

// ── Sipariş & satır & atama ─────────────────────────────────────────────────
export const OrderStatus = z.enum([
  'unmapped', // eşleme bulunamadı, sipariş kaybolmaz (§4 hata modeli)
  'pending', // stok bekliyor
  'partial', // kısmen teslim
  'fulfilled', // tamamı teslim
  'revoked', // iade/iptal
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const OrderLineStatus = z.enum(['pending', 'partial', 'fulfilled']);
export type OrderLineStatus = z.infer<typeof OrderLineStatus>;

export const AssignmentStatus = z.enum(['active', 'suspended', 'replaced', 'revoked', 'expired']);
export type AssignmentStatus = z.infer<typeof AssignmentStatus>;

// ── Tedarik zinciri (§12) ───────────────────────────────────────────────────
export const PurchaseOrderStatus = z.enum([
  'ordered',
  'partially_received',
  'received',
  'cancelled',
]);
export type PurchaseOrderStatus = z.infer<typeof PurchaseOrderStatus>;

// ── Müşteri etiketleri (§3) ─────────────────────────────────────────────────
export const CustomerTag = z.enum(['vip', 'wholesale', 'risky', 'blocked']);
export type CustomerTag = z.infer<typeof CustomerTag>;

// ── Denetim (§8) ────────────────────────────────────────────────────────────
export const AuditAction = z.enum([
  'reveal',
  'replace',
  'revoke',
  'suspend',
  'unsuspend',
  'import',
  'login',
  'assign',
  'resend',
]);
export type AuditAction = z.infer<typeof AuditAction>;
