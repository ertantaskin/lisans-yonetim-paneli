import { sql } from 'drizzle-orm';
import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { products } from './products';
import { suppliers } from './suppliers';

/**
 * po_status — satın alma emri durumu (§12). draft: taslak, ordered: sipariş verildi,
 * partial: kısmen teslim alındı, received: tamamı teslim alındı, cancelled: iptal.
 * NOT: yeni enum kendi şema dosyasında tanımlanır (enums.ts orkestratör dosyası).
 */
export const poStatusEnum = pgEnum('po_status', [
  'draft',
  'ordered',
  'partial',
  'received',
  'cancelled',
]);

/**
 * purchase_orders — tedarikçiye verilen satın alma emri (§12). qtyReceived teslim
 * alındıkça artar; status otomatik partial/received'a döner. Teslim alınan gerçek
 * key'lerin stok girişi AYRIDIR (stock.import) — burada yalnız emir + adet kaydı tutulur.
 */
export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    status: poStatusEnum('status').notNull().default('draft'),
    qtyOrdered: integer('qty_ordered').notNull(),
    qtyReceived: integer('qty_received').notNull().default(0),
    unitCostCents: integer('unit_cost_cents'),
    currency: text('currency').notNull().default('TRY'),
    eta: timestamp('eta', { withTimezone: true }),
    orderedAt: timestamp('ordered_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('purchase_orders_status_idx').on(t.status), index('purchase_orders_supplier_idx').on(t.supplierId)],
);

export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type NewPurchaseOrder = typeof purchaseOrders.$inferInsert;
