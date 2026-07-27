import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sites } from './sites';

/**
 * site_remote_products — bir sitenin (mağaza) ürün kataloğu SNAPSHOT'ı; WP eklentisinden
 * senkronlanır (§3). Amaç: panelde PROAKTİF eşleme — operatör sipariş gelmeden mağaza ürününü
 * ADIYLA seçip panel ürününe eşler (elle ham ID yazmadan). SIR YOK (yalnız ad/sku/tip; fiyat/
 * lisans DEĞİL). Eşleme ayrı tabloda (site_product_mappings) — bu tablo yalnız "hangi ürünler var"
 * bilgisidir; katalog silinse eşleme kopmaz. Senkron = sitenin tam anlık durumu (delete+insert).
 */
export const siteRemoteProducts = pgTable(
  'site_remote_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    remoteProductId: text('remote_product_id').notNull(),
    remoteVariationId: text('remote_variation_id'),
    name: text('name').notNull(),
    sku: text('sku'),
    /** WP ürün tipi: simple | variable | variation. */
    kind: text('kind'),
    active: boolean('active').notNull().default(true),
    syncedAt: timestamp('synced_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('site_remote_products_uniq').on(
      t.siteId,
      t.remoteProductId,
      t.remoteVariationId,
    ),
    index('site_remote_products_site_idx').on(t.siteId),
  ],
);

export type SiteRemoteProduct = typeof siteRemoteProducts.$inferSelect;
export type NewSiteRemoteProduct = typeof siteRemoteProducts.$inferInsert;
