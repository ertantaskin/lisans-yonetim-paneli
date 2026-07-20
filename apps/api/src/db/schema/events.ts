import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orders } from './orders';

/**
 * fulfillment_events — sipariş timeline'ı (§3). Panel + WP meta box'ta gösterilir.
 * Örn: order_received, partially_fulfilled, fulfilled, resent, revoked.
 */
export const fulfillmentEvents = pgTable(
  'fulfillment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    message: text('message'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('fulfillment_events_order_idx').on(t.orderId, t.createdAt)],
);

export type FulfillmentEvent = typeof fulfillmentEvents.$inferSelect;
export type NewFulfillmentEvent = typeof fulfillmentEvents.$inferInsert;
