import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * plugin_releases — WP eklentisinin merkezî güncelleme kaynağı (§16 "eklenti sürümü
 * tek yerden dağıtılır"). Panel, WordPress güncelleme-denetçisine sürüm bilgisi + .zip
 * paketi sunar. Eklenti kodu SIR DEĞİLDİR: info/download uçları PUBLIC (WP core paketi
 * imzasız çeker); yalnız yeni sürüm YAYINLAMA admin-gated'dır.
 *
 * `zip_b64` eklenti .zip paketinin base64 gövdesidir (paket küçük, main.ts bodyLimit
 * 1MB yeterli). `version` tekildir (aynı sürüm yeniden yayınlanırsa UPDATE = upsert).
 */
export const pluginReleases = pgTable(
  'plugin_releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Semver benzeri sürüm etiketi (ör. '1.2.0'); tekil kimlik. */
    version: text('version').notNull(),
    /** Serbest metin değişiklik günlüğü (WP "sections.changelog" olarak gösterilir). */
    changelog: text('changelog'),
    /** Eklenti .zip paketinin base64 kodlu gövdesi. */
    zipB64: text('zip_b64').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex('plugin_releases_version_uniq').on(t.version)],
);

export type PluginRelease = typeof pluginReleases.$inferSelect;
export type NewPluginRelease = typeof pluginReleases.$inferInsert;
