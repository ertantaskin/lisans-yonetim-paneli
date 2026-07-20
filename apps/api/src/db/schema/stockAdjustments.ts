import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { products } from './products';

/**
 * stock_adjustments — sebepli stok düzeltme izi (§12 "sebepsiz değişiklik imkânsız").
 * void/damage/correct/recall aksiyonları buraya düşer; her satır bir sebep + aktör taşır.
 * license_item_id BİLEREK PLAIN uuid (FK YOK): item hard-delete edilse bile düzeltme izi kalır;
 * ayrıca recall/adjust W2 modülü license_items'a build-bağımlılığı kurmaz (RAW SQL ile dokunur).
 * action metin (enum değil) — yeni düzeltme türleri migration gerektirmez.
 */
export const stockAdjustments = pgTable(
  'stock_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    /** İlgili lisans satırı (varsa) — PLAIN, FK YOK. */
    licenseItemId: uuid('license_item_id'),
    /** 'void' | 'damage' | 'correct' | 'recall'. */
    action: text('action').notNull(),
    qty: integer('qty').notNull().default(0),
    reason: text('reason').notNull(),
    actor: text('actor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('stock_adjustments_product_idx').on(t.productId)],
);

export type StockAdjustment = typeof stockAdjustments.$inferSelect;
export type NewStockAdjustment = typeof stockAdjustments.$inferInsert;
