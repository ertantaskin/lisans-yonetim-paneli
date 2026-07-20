import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orders } from './orders';
import { products } from './products';
import { sites } from './sites';

/**
 * delivery_templates — teslimat mail şablonları (§6). Tamamen panelde.
 * Öncelik: site override > ürün > yerleşik varsayılan.
 * Değişkenler: {{key}} {{units}} {{order_no}} {{site_name}} {{product_name}} {{customer_email}}
 */
export const deliveryTemplates = pgTable('delivery_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }),
  siteId: uuid('site_id').references(() => sites.id, { onDelete: 'cascade' }),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

/**
 * email_log — gönderim/bounce/delivered izi (§6, §9). Gövde 12 ay sonra maskelenir.
 */
export const emailLog = pgTable(
  'email_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    // queued | sent | failed | bounced | delivered
    status: text('status').notNull().default('queued'),
    providerMessageId: text('provider_message_id'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('email_log_order_idx').on(t.orderId)],
);

export type DeliveryTemplate = typeof deliveryTemplates.$inferSelect;
export type EmailLog = typeof emailLog.$inferSelect;
