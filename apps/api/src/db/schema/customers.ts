import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * customers — müşteri profili (§13). Sipariş/atama sayıları TÜRETİLİR (orders/assignments
 * üzerinden anlık hesaplanır); bu tablo yalnız yöneticinin eklediği kalıcı meta veriyi tutar:
 * etiketler + serbest not. e-posta tekil kimlik (lowercase+trim ile yazılır).
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex('customers_email_uniq').on(t.email)],
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
