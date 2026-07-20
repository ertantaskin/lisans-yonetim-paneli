import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { products } from './products';
import { sites } from './sites';

/**
 * site_product_mappings — site tarafındaki remote ürün/varyasyon → panel ürünü (§3).
 * Sipariş geldiğinde (site_id, remote_product_id[, remote_variation_id]) ile panel
 * ürünü bulunur. bundle_qty: 1 Woo adedi = N key.
 */
export const siteProductMappings = pgTable(
  'site_product_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    remoteProductId: text('remote_product_id').notNull(),
    remoteVariationId: text('remote_variation_id'),
    bundleQty: integer('bundle_qty').notNull().default(1),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // Aynı site+remote ürün+varyasyon tek eşleme.
    uniqueIndex('mappings_site_remote_uniq').on(t.siteId, t.remoteProductId, t.remoteVariationId),
  ],
);

export type SiteProductMapping = typeof siteProductMappings.$inferSelect;
export type NewSiteProductMapping = typeof siteProductMappings.$inferInsert;
