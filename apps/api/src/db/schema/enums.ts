import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL enum tipleri — @jetlisans/shared enum'larıyla birebir.
 * Değer eklerken önce shared/src/domain/enums.ts, sonra burası güncellenir.
 */
export const siteTypeEnum = pgEnum('site_type', ['woocommerce', 'marketplace', 'reseller']);

export const productKindEnum = pgEnum('product_kind', ['key', 'account', 'custom', 'code']);
export const usageModeEnum = pgEnum('usage_mode', ['single', 'multi']);
export const fulfillmentPolicyEnum = pgEnum('fulfillment_policy', [
  'partial-auto',
  'partial-approval',
  'all-or-nothing',
]);
export const onExpiryEnum = pgEnum('on_expiry', ['hide', 'keep']);

export const licenseItemStatusEnum = pgEnum('license_item_status', [
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

export const orderStatusEnum = pgEnum('order_status', [
  'unmapped',
  'pending',
  'partial',
  'fulfilled',
  'revoked',
]);
export const orderLineStatusEnum = pgEnum('order_line_status', ['pending', 'partial', 'fulfilled']);
export const assignmentStatusEnum = pgEnum('assignment_status', [
  'active',
  'suspended',
  'replaced',
  'revoked',
  'expired',
]);

export const purchaseOrderStatusEnum = pgEnum('purchase_order_status', [
  'ordered',
  'partially_received',
  'received',
  'cancelled',
]);

export const auditActionEnum = pgEnum('audit_action', [
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
