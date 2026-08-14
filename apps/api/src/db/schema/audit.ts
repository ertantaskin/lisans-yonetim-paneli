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
  /*
   * İNDEKSLER — denetim izi EKRANININ (§8) süzgeçlerini karşılar.
   *
   * Tabloda yalnız `created_at` indeksi vardı; "bu admin ne yaptı" ve "bu kayda ne oldu"
   * sorguları tam tablo taramasıydı. audit_log append-only ve en hızlı büyüyen tablolardan
   * biri (her reveal/revoke/import bir satır) → ekran açılır açılmaz taranamaz hale gelirdi.
   *
   * Sıralama HER ZAMAN `created_at DESC` olduğu için bileşik indekslerin ikinci kolonu da
   * DESC: yön ayna değildir (0031 dersi), tie-break ancak aynı yönde indeksten karşılanır.
   */
  (t) => [
    index('audit_log_created_idx').on(t.createdAt),
    index('audit_log_actor_idx').on(t.actor, t.createdAt.desc()),
    index('audit_log_target_idx').on(t.targetType, t.targetId, t.createdAt.desc()),
    index('audit_log_action_idx').on(t.action, t.createdAt.desc()),
  ],
);

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
