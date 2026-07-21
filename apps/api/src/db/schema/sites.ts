import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
  /**
   * api_key rotasyonunda (rekey, §14) eski anahtarın hash'i + rotasyon zamanı. rekey api_key'i
   * anında değiştirdiğinden ESKİ api_key ile gelen istek normalde en başta (findForAuth lookup)
   * 401 alırdı — hmac grace'i bile devreye giremezdi. Bu iki alan HMAC_KEY_ROTATION_GRACE_SEC
   * (24s) boyunca eski api_key hash'iyle de siteyi bulmayı sağlar (hmac grace deseninin birebir aynası).
   */
  apiKeyHashPrev: text('api_key_hash_prev'),
  apiKeyRotatedAt: timestamp('api_key_rotated_at', { withTimezone: true }),
  senderEmail: text('sender_email'),
  senderDomainVerified: boolean('sender_domain_verified').notNull().default(false),
  /** Geri kanal webhook hedefi (WP eklentisi) — null ise webhook gönderilmez (§2). */
  webhookUrl: text('webhook_url'),
  /**
   * Günlük satış kotası (§5) — bu site günde en fazla bu kadar sipariş push edebilir.
   * null = limitsiz. SERT tavan: aşımda 429 (Retry-After) döner ve sipariş REDDEDİLİR.
   * (Kontrol OrdersService.createOrder içinde, idempotency lookup'ından sonra + site
   * advisory-lock altında → idempotent retry takılmaz, say-sonra-ekle yarışı yok.)
   */
  salesDailyQuota: integer('sales_daily_quota'),
  /**
   * Dinamik satış kotası (§8) — açıksa günlük eşik = son 30 günün ORTALAMA günlük sipariş
   * sayısı × reviewMultiplier (tabanı DYNAMIC_MIN_FLOOR). Eşik aşılırsa sipariş REDDEDİLMEZ;
   * held_for_review ile KABUL edilip manuel onaya alınır ("AI önerir/insan onaylar" felsefesi,
   * §15). salesDailyQuota (sert 429) ile ortogonal — ikisi de açıksa önce sert tavan bakılır.
   * Varsayılan KAPALI → hiçbir mevcut site etkilenmez (geriye dönük uyumlu).
   */
  dynamicQuotaEnabled: boolean('dynamic_quota_enabled').notNull().default(false),
  /** Dinamik eşik çarpanı (§8): 30g-ortalama × bu değer. Varsayılan 3. */
  reviewMultiplier: integer('review_multiplier').notNull().default(3),
  /**
   * Sandbox (test modu, §14). true ise teslimat maili gerçek müşteriye GİTMEZ;
   * yöneticiye (MAIL_FROM) yönlendirilir + konu başına '[TEST MODU] ' eklenir.
   */
  sandbox: boolean('sandbox').notNull().default(false),
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
