import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * site_connect_tokens — tek-seferlik "bağlan kodu" onboarding (§14).
 *
 * Panel operatörü siteyi kısa (XXXXX-XXXXX) bir kodla bağlar; kod karşılığında API,
 * taze api_key + hmac_secret'ı YALNIZ BİR KEZ teslim eder. Ham kod DB'de DURMAZ —
 * yalnız sha256 hex'i (code_hash) tutulur (claim'de yeniden hash'lenip aranır). Creds
 * envelope + site AAD ile şifreli saklanır ve claim/expiry anında SİLİNİR
 * (api_key_enc/hmac_secret_enc → null) → sızıntı penceresi 15dk + tek kullanımla sınırlı.
 *
 * siteId PLAIN uuid (FK YOK) — security_events gibi, kayıt site yaşam döngüsünden
 * bağımsız kalır; token zaten kısa ömürlü + best-effort silinir.
 */
export const siteConnectTokens = pgTable(
  'site_connect_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id').notNull(),
    /** Kodun sha256 hex'i — ham kod ASLA saklanmaz. */
    codeHash: text('code_hash').notNull(),
    /** Taze api_key (envelope + site AAD şifreli) — claim/expiry'de null'lanır. */
    apiKeyEnc: text('api_key_enc'),
    /** Taze hmac_secret (envelope + site AAD şifreli) — claim/expiry'de null'lanır. */
    hmacSecretEnc: text('hmac_secret_enc'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // claim() code_hash ile arar → tekil arama indeksi.
    index('site_connect_tokens_code_idx').on(t.codeHash),
    // issue() aynı sitenin tüketilmemiş satırlarını siler → site bazlı indeks.
    index('site_connect_tokens_site_idx').on(t.siteId),
  ],
);

export type SiteConnectToken = typeof siteConnectTokens.$inferSelect;
export type NewSiteConnectToken = typeof siteConnectTokens.$inferInsert;
