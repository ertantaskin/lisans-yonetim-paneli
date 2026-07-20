import { sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { orderLineStatusEnum, orderStatusEnum } from './enums';
import { products } from './products';
import { sites } from './sites';

/**
 * orders — panele bildirilmiş sipariş (§3).
 * idempotency_key UNIQUE (site+order+line) → çifte satış imkânsız (§2).
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'restrict' }),
    remoteOrderId: text('remote_order_id').notNull(),
    customerEmail: text('customer_email').notNull(),
    status: orderStatusEnum('status').notNull().default('pending'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('orders_idempotency_key_uniq').on(t.idempotencyKey),
    uniqueIndex('orders_site_remote_uniq').on(t.siteId, t.remoteOrderId),
  ],
);

export const orderLines = pgTable('order_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'restrict' }),
  remoteLineId: text('remote_line_id').notNull(),
  qty: integer('qty').notNull(),
  fulfilledQty: integer('fulfilled_qty').notNull().default(0),
  status: orderLineStatusEnum('status').notNull().default('pending'),
  priority: integer('priority').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderLine = typeof orderLines.$inferSelect;
export type NewOrderLine = typeof orderLines.$inferInsert;
