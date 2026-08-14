import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { fulfillmentPolicyEnum, onExpiryEnum, productKindEnum, usageModeEnum } from './enums';
import { productCategories } from './productCategories';

/**
 * products — tek çekirdek, tüm ürün tipleri (§11).
 * usage_mode/validity_days/stockless kombinasyonları ürün tipini belirler.
 */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    kind: productKindEnum('kind').notNull().default('key'),

    /**
     * Kategori (§17 bilgi mimarisi) — `/stock` giriş ekranı bu alana göre gruplanır.
     *
     * `ON DELETE SET NULL` bilinçli: kategori silinince ÜRÜN SİLİNMEZ, yalnız kategorisiz
     * kalır ("Kategorisiz" kartında görünür). RESTRICT olsaydı operatör kategoriyi silmek
     * için önce her ürünü elle taşımak zorunda kalırdı; ürünü silmek ise felaket olurdu
     * (ürün stok/sipariş taşır). Silme onayında "N ürün Kategorisiz olacak" yazılır.
     */
    categoryId: uuid('category_id').references(() => productCategories.id, {
      onDelete: 'set null',
    }),

    /** Payload alan şeması (ör. {username, password} hesap için). */
    payloadSchema: jsonb('payload_schema'),

    usageMode: usageModeEnum('usage_mode').notNull().default('single'),
    /** multi (MAK) için tek key'in taşıyabileceği toplam kullanım. */
    maxUses: integer('max_uses'),

    /** Abonelik: süre TESLİMLE başlar (valid_until = delivered_at + validity_days). */
    validityDays: integer('validity_days'),
    onExpiry: onExpiryEnum('on_expiry').notNull().default('hide'),

    /** Stoksuz/ön sipariş: pending normal akış, release_at'te teslim. */
    stockless: boolean('stockless').notNull().default(false),
    releaseAt: timestamp('release_at', { withTimezone: true }),

    fulfillmentPolicy: fulfillmentPolicyEnum('fulfillment_policy')
      .notNull()
      .default('partial-auto'),
    warrantyDays: integer('warranty_days'),
    /** Stok girişinde satır doğrulama regex'i (§13 "Onayla ve Dağıt"). */
    keyFormat: text('key_format'),
    /**
     * Düşük stok uyarı eşiği (§12). null = uyarı KAPALI; >=0 ise availableStock <= eşik
     * olduğunda 'low_stock' bildirimi üretilir (dedupe'lu). Detection `IS NOT NULL` filtreler.
     */
    lowStockThreshold: integer('low_stock_threshold'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('products_sku_uniq').on(t.sku),
    // Kategori kartlarının sayaç sorgusu + kategoriye süzülmüş ürün listesi bu indeksi kullanır.
    index('products_category_idx').on(t.categoryId),
  ],
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
