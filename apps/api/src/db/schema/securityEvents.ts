import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * security_events — operasyonel güvenlik/anomali izi (§5/§15). Velocity (hız),
 * kota aşımı, müşteri değişim-oranı anomalisi ve blocklist eşleşmeleri buraya
 * düşer. AUTO-SUSPEND YAPILMAZ: kayıt yalnız yüzeye çıkar, aksiyonu insan onaylar (§15).
 *
 * siteId PLAIN uuid (FK YOK) — site silinse bile güvenlik izi kopmaz/kalır.
 * type/severity serbest metin (enum değil; yeni tür eklemek migration gerektirmesin).
 */
export const securityEvents = pgTable(
  'security_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'velocity' | 'quota_exceeded' | 'anomaly' | 'blocklist' */
    type: text('type').notNull(),
    /** 'info' | 'warning' | 'critical' */
    severity: text('severity').notNull().default('warning'),
    // Site FK YOK — güvenlik izi site yaşam döngüsünden bağımsız kalır.
    siteId: uuid('site_id'),
    /** İlgili özne (ör. e-posta/domain) — opsiyonel. */
    subject: text('subject'),
    /** İnsan-okur açıklama (redakteli — sır ASLA girmez). */
    detail: text('detail').notNull(),
    /** Ek yapılandırılmış bağlam (eşik, sayım vb.). */
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('security_events_created_idx').on(t.createdAt.desc()),
    index('security_events_type_idx').on(t.type),
  ],
);

export type SecurityEvent = typeof securityEvents.$inferSelect;
export type NewSecurityEvent = typeof securityEvents.$inferInsert;
