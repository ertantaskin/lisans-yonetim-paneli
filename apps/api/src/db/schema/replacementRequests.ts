import { sql } from 'drizzle-orm';
import { boolean, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { assignments } from './assignments';
import { orderLines, orders } from './orders';
import { sites } from './sites';

/**
 * replacement_status — değişim talebinin yaşam döngüsü (§13).
 * open → info_requested (bilgi istendi) → approved (değişim yapıldı) / rejected (reddedildi).
 * Not: enum'u schema/enums.ts'e DEĞİL bu dosyada tutuyoruz; index.ts'e barrel ekini
 * orkestratör yapar (bu modül henüz app.module'e bağlı değil).
 */
export const replacementStatusEnum = pgEnum('replacement_status', [
  'open',
  'info_requested',
  'approved',
  'rejected',
]);

/**
 * replacement_requests — müşteri değişim/garanti talepleri (§13).
 * Site imzadan çözülür; talep siparişe (order) ve varsa tek atamaya (assignment) bağlanır.
 * Onaylanınca eski atama revoke edilir, yenisi atanır (new_assignment_id).
 */
export const replacementRequests = pgTable(
  'replacement_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    // Talep belirli bir satıra bağlıysa (atamadan türetilir) tutulur; satır silinirse kopar.
    lineId: uuid('line_id').references(() => orderLines.id, { onDelete: 'set null' }),
    // Değiştirilecek atama; silinirse talep kaydı kalır (izlenebilirlik).
    assignmentId: uuid('assignment_id').references(() => assignments.id, { onDelete: 'set null' }),
    customerEmail: text('customer_email').notNull(),
    reason: text('reason').notNull(),
    status: replacementStatusEnum('status').notNull().default('open'),
    // Talep anında garanti penceresinde mi (assignment.delivered_at + warranty_days).
    withinWarranty: boolean('within_warranty').notNull().default(false),
    resolutionNote: text('resolution_note'),
    // Onayda atanan yeni atamanın id'si.
    newAssignmentId: uuid('new_assignment_id'),
    resolvedBy: text('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('replacement_requests_status_idx').on(t.status),
    index('replacement_requests_email_idx').on(t.customerEmail),
  ],
);

export type ReplacementRequest = typeof replacementRequests.$inferSelect;
export type NewReplacementRequest = typeof replacementRequests.$inferInsert;
