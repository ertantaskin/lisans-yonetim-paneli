import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * notifications — panel içi bildirim akışı (§12). Düşük stok, günlük özet vb. sistem
 * olayları. severity 'warning'/'critical' ise best-effort Telegram'a da düşer (env-gated).
 * Sır ASLA meta'ya yazılmaz; yalnız kimlik/eşik gibi ops metrikleri.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Bildirim türü (ör. 'low_stock', 'daily_summary'). */
    type: text('type').notNull(),
    /** 'info' | 'warning' | 'critical' — UI rozeti + Telegram tetiği (warning+). */
    severity: text('severity').notNull().default('info'),
    title: text('title').notNull(),
    message: text('message').notNull(),
    /** Yapılandırılmış bağlam (ör. {productId, sku, available, threshold}). Sır YOK. */
    meta: jsonb('meta'),
    /** Telegram'a gönderildi mi (best-effort; env yoksa false kalır). */
    sentTelegram: boolean('sent_telegram').notNull().default(false),
    /**
     * Üst bardaki bildirim çanı okuma durumu (§17). null = okunmamış. GLOBAL (panel tek
     * operasyon ekibi tarafından izlenir) — per-admin okuma durumu bilinçli olarak YOK
     * (ayrı tablo + join maliyeti; çan sayacı sıcak yol).
     */
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('notifications_created_idx').on(t.createdAt.desc()),
    index('notifications_type_idx').on(t.type),
    // Çan sayacı (okunmamış) sıcak yolu — partial index yalnız okunmamışları kapsar.
    index('notifications_unread_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.readAt} IS NULL`),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
