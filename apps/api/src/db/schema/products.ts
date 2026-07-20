import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { fulfillmentPolicyEnum, onExpiryEnum, productKindEnum, usageModeEnum } from './enums';

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
    lowStockThreshold: integer('low_stock_threshold').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex('products_sku_uniq').on(t.sku)],
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
