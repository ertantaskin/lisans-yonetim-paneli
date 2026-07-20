import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { siteTypeEnum } from './enums';

/**
 * sites — her WooCommerce/pazar yeri kanalı bir "tenant" (§1, §3).
 * hmac_secret şifreli saklanır; api_key yalnız hash olarak tutulur.
 */
export const sites = pgTable('sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: siteTypeEnum('type').notNull().default('woocommerce'),
  domain: text('domain').notNull(),
  apiKeyHash: text('api_key_hash').notNull(),
  hmacSecretEnc: text('hmac_secret_enc').notNull(),
  /**
   * Anahtar rotasyonunda eski secret (§4). Rotasyondan sonra HMAC_KEY_ROTATION_GRACE_SEC
   * (24s) boyunca guard hem yeni hem eski secret'ı kabul eder → WP eklentisi kesintisiz
   * yeni secret'a geçer. Süre dolunca eski secret reddedilir.
   */
  hmacSecretPrevEnc: text('hmac_secret_prev_enc'),
  hmacSecretRotatedAt: timestamp('hmac_secret_rotated_at', { withTimezone: true }),
  senderEmail: text('sender_email'),
  senderDomainVerified: boolean('sender_domain_verified').notNull().default(false),
  /** Geri kanal webhook hedefi (WP eklentisi) — null ise webhook gönderilmez (§2). */
  webhookUrl: text('webhook_url'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type Site = typeof sites.$inferSelect;
export type NewSite = typeof sites.$inferInsert;
