import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orders } from './orders';
import { sites } from './sites';

/**
 * outbox_events — geri kanal webhook teslim kuyruğu (§2, §16 dead-letter).
 * order.fulfilled / order.partially_fulfilled olayları siteye HMAC imzalı POST'lanır.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    // pending | delivered | failed
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('outbox_status_idx').on(t.status, t.createdAt)],
);

export type OutboxEvent = typeof outboxEvents.$inferSelect;
