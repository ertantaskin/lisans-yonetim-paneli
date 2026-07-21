import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * saved_views — operatörün bir tablonun mevcut filtre/arama durumunu (URL query)
 * adlandırıp kaydettiği "kayıtlı görünümler" (§14). Actor bazlı: her admin yalnız
 * kendi görünümlerini görür/siler (actor = getActor() → x-admin-actor → @AdminActor).
 * `query` kaydedilen URL query string'idir (ör. '?status=pending&q=windows');
 * lisans verisi/sır İÇERMEZ, yalnız görünüm durumu.
 */
export const savedViews = pgTable(
  'saved_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Görünümü kaydeden admin (audit_log.actor ile aynı biçim, ör. 'admin:ali@x.com'). */
    actor: text('actor').notNull(),
    /** Görünümün ait olduğu sayfa/tablo (ör. 'orders', 'stock', 'sites'). */
    page: text('page').notNull(),
    /** Operatörün verdiği görünen ad (ör. 'Bekleyenler'). */
    name: text('name').notNull(),
    /** Kaydedilen URL query string (ör. '?status=pending'). */
    query: text('query').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('saved_views_actor_page_idx').on(t.actor, t.page, t.createdAt)],
);

export type SavedView = typeof savedViews.$inferSelect;
export type NewSavedView = typeof savedViews.$inferInsert;
