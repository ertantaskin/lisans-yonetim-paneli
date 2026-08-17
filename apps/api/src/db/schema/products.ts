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
import {
  fulfillmentPolicyEnum,
  multiUseDistributionEnum,
  onExpiryEnum,
  productKindEnum,
  usageModeEnum,
} from './enums';
import { productCategories } from './productCategories';
import { productGuides } from './productGuides';

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

    /**
     * Kurulum / etkinleştirme rehberi (§7) — müşteriye teslimatla BİRLİKTE giden talimat.
     *
     * Metin ürüne GÖMÜLMEZ, `product_guides` kaydına bağlanır: aynı anlatı onlarca SKU'da
     * ortaktır (bkz. productGuides.ts). `ON DELETE SET NULL` — rehber silinince ürün
     * silinmez, yalnız rehbersiz kalır (kategori alanıyla aynı karar).
     *
     * null = rehber yok. Bu GEÇERLİ bir durumdur: her ürün talimat gerektirmez.
     */
    guideId: uuid('guide_id').references(() => productGuides.id, {
      onDelete: 'set null',
    }),

    /** Payload alan şeması (ör. {username, password} hesap için). */
    payloadSchema: jsonb('payload_schema'),

    usageMode: usageModeEnum('usage_mode').notNull().default('single'),
    /** multi (MAK) için tek key'in taşıyabileceği toplam kullanım. */
    maxUses: integer('max_uses'),
    /**
     * MAK DAĞITIMI (yalnız usage_mode='multi' iken anlamlı; single üründe okunmaz).
     *
     * 'fewest-keys' (varsayılan, ESKİ davranış): talebi tek başına karşılayan anahtar önce →
     *   müşteri mümkün olduğunca TEK anahtar alır. MAK anahtarı PAYLAŞIMLI olduğu için her
     *   fazladan anahtar, kalan kapasitesi kadar fazladan aşırı-etkinleştirme yüzeyidir.
     * 'one-per-key': her birim AYRI anahtardan (3 birim + 3 uygun anahtar = 3×1); ayrı anahtar
     *   bitince kalan talep doldurma davranışına düşer (1 anahtar + 6 birim = tek anahtarda 6).
     *   Bilinçli ödün: anahtar sayısı ↑ ⇒ aşırı-etkinleştirme yüzeyi ↑ (bkz. @lisans/shared).
     *
     * NOT NULL + DEFAULT: mevcut ürünlerin davranışı DEĞİŞMEZ (yeni politika opt-in).
     */
    multiUseDistribution: multiUseDistributionEnum('multi_use_distribution')
      .notNull()
      .default('fewest-keys'),

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
    // Rehber listesindeki "kaç ürün kullanıyor" sayacı + silmeden önceki etki sayımı bu FK'yı
    // tarar. İndekssiz FK bu projede daha önce (0042) düzeltilen bir bulgu sınıfıydı.
    index('products_guide_idx').on(t.guideId),
  ],
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
