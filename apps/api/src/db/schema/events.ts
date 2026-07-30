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
  (t) => [
    index('fulfillment_events_order_idx').on(t.orderId, t.createdAt),
    // Saklama/budama (retention) sıcak yolu: RetentionService created_at'e göre eski satırları
    // batch'ler halinde siler. Mevcut order_idx (order_id, created_at) prefiksi order_id olduğu
    // için `WHERE created_at < X` taramasını KARŞILAMAZ → ayrı created_at index'i gerekir
    // (migration 0029). fulfillment_events ~2×sipariş hızında büyür; index'siz her prune tam-tablo tarar.
    index('fulfillment_events_created_idx').on(t.createdAt),
  ],
);

export type FulfillmentEvent = typeof fulfillmentEvents.$inferSelect;
export type NewFulfillmentEvent = typeof fulfillmentEvents.$inferInsert;
