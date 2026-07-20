import { z } from 'zod';
import { OrderLineStatus, OrderStatus } from '../domain/enums';

/**
 * /v1/orders sözleşmesi (§4). Eklenti sipariş bildirir; panel atomik atama yapıp
 * assignment listesi döner.
 *
 *   201 fully_fulfilled · 207 partial_fulfillment · 202 pending_stock
 *
 * Idempotency-Key = site+order+line (UNIQUE) — tekrar gelen istek yeni atama
 * yapmaz, mevcut cevabı döner.
 */

// ── İstek ───────────────────────────────────────────────────────────────────
export const CreateOrderLine = z.object({
  /** Eklenti tarafındaki satır kimliği (idempotency parçası). */
  remoteLineId: z.string().min(1),
  remoteProductId: z.string().min(1),
  remoteVariationId: z.string().min(1).optional(),
  qty: z.number().int().positive(),
  /** Ürün varsayılan politikasını sipariş bazında ezme (opsiyonel). */
  policyOverride: z.enum(['partial-auto', 'partial-approval', 'all-or-nothing']).optional(),
});
export type CreateOrderLine = z.infer<typeof CreateOrderLine>;

export const CreateOrderRequest = z.object({
  remoteOrderId: z.string().min(1),
  customerEmail: z.string().email(),
  lines: z.array(CreateOrderLine).min(1),
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequest>;

// ── Yanıt ───────────────────────────────────────────────────────────────────
export const AssignmentResult = z.object({
  assignmentId: z.string().uuid(),
  remoteLineId: z.string(),
  units: z.number().int().positive(),
  validUntil: z.string().datetime().nullable(),
});
export type AssignmentResult = z.infer<typeof AssignmentResult>;

export const OrderLineResult = z.object({
  remoteLineId: z.string(),
  status: OrderLineStatus,
  requestedQty: z.number().int().nonnegative(),
  fulfilledQty: z.number().int().nonnegative(),
});
export type OrderLineResult = z.infer<typeof OrderLineResult>;

export const CreateOrderResponse = z.object({
  orderId: z.string().uuid(),
  status: OrderStatus,
  assignments: z.array(AssignmentResult),
  lines: z.array(OrderLineResult),
});
export type CreateOrderResponse = z.infer<typeof CreateOrderResponse>;

/** §4 HTTP durum → anlam eşlemesi. */
export const ORDER_HTTP_STATUS = {
  fullyFulfilled: 201,
  partialFulfillment: 207,
  pendingStock: 202,
  alreadyProcessed: 409,
  mappingNotFound: 404,
  invalidSignature: 401,
} as const;
