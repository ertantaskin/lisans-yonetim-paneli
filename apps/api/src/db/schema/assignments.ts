import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { assignmentStatusEnum } from './enums';
import { licenseItems } from './licenseItems';
import { orderLines, orders } from './orders';

/**
 * assignments — lisans ↔ sipariş bağı (§3). "Eski anahtarlar" değişim geçmişiyle
 * assignment_history'de tutulur.
 */
export const assignments = pgTable(
  'assignments',
  {
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
  },
  (t) => [
    // Süre-bitişi taraması (§11): yalnız süreli AKTİF atamalar üzerinde çalışsın —
    // partial index seq-scan'i önler (5 dk'da bir çalışan sweep + getDeliveries filtresi).
    index('assignments_expiry_idx')
      .on(t.validUntil)
      .where(sql`${t.status} = 'active' AND ${t.validUntil} IS NOT NULL`),
    // Sipariş teslimatları (§4): getDeliveries + tamamlama motoru order_id üzerinden
    // atamaları çeker; status bileşik → aktif/expired filtresi index'ten karşılanır.
    index('assignments_order_idx').on(t.orderId, t.status),
    // Satır-bazlı atama sorguları (recompute, kısmi teslimat) FK'yi indexler.
    index('assignments_line_idx').on(t.lineId),
    // license_item ↔ atama ters araması (revoke/değişim, mutabakat) FK'yi indexler.
    index('assignments_license_item_idx').on(t.licenseItemId),
  ],
);

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
