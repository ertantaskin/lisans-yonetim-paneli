import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { auditActionEnum } from './enums';

/**
 * audit_log — append-only denetim izi (§8). reveal/replace/revoke/import/login
 * buraya düşer. actor ör. "wp:kullanici@site" veya "panel:uuid".
 * UPDATE/DELETE uygulama katmanında yasak (yalnız insert).
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    action: auditActionEnum('action').notNull(),
    actor: text('actor').notNull(),
    /** Hedef kaynak (ör. assignment/license_item id). */
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** Ek bağlam (redakteli — payload düz metin ASLA girmez). */
    meta: jsonb('meta'),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('audit_log_created_idx').on(t.createdAt)],
);

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
