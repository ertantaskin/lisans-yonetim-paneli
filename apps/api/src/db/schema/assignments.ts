import { sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { assignmentStatusEnum } from './enums';
import { licenseItems } from './licenseItems';
import { orderLines, orders } from './orders';

/**
 * assignments — lisans ↔ sipariş bağı (§3). "Eski anahtarlar" değişim geçmişiyle
 * assignment_history'de tutulur.
 */
export const assignments = pgTable('assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  lineId: uuid('line_id')
    .notNull()
    .references(() => orderLines.id, { onDelete: 'cascade' }),
  licenseItemId: uuid('license_item_id')
    .notNull()
    .references(() => licenseItems.id, { onDelete: 'restrict' }),
  /** multi üründe bu atamanın tükettiği kullanım adedi. */
  units: integer('units').notNull().default(1),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  status: assignmentStatusEnum('status').notNull().default('active'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

/** assignment_history — sebepli değişim izi ("eski anahtarlar", §3). */
export const assignmentHistory = pgTable('assignment_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  assignmentId: uuid('assignment_id')
    .notNull()
    .references(() => assignments.id, { onDelete: 'cascade' }),
  oldLicenseItemId: uuid('old_license_item_id'),
  newLicenseItemId: uuid('new_license_item_id'),
  reason: text('reason').notNull(),
  actor: text('actor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type Assignment = typeof assignments.$inferSelect;
export type NewAssignment = typeof assignments.$inferInsert;
