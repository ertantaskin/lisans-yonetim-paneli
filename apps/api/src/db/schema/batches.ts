import { sql } from 'drizzle-orm';
import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { products } from './products';
import { purchaseOrders } from './purchaseOrders';
import { suppliers } from './suppliers';

/**
 * batch_status — teslim alınan parti durumu (§12). active: normal, recalled: geri
 * çekildi (satılmamış key'ler iptal edilir), voided: elle geçersiz kılındı.
 * NOT: yeni enum kendi şema dosyasında tanımlanır (enums.ts orkestratör dosyası).
 */
export const batchStatusEnum = pgEnum('batch_status', ['active', 'recalled', 'voided']);

/**
 * batches — bir teslimatta gelen key partisi (§12). license_items.batch_id bu satıra
 * (RAW SQL ile) bağlanır; recall bu parti üzerinden satılmamış key'leri iptal eder.
 * supplierId/purchaseOrderId opsiyonel — elle girilen partiler için null olabilir.
 */
export const batches = pgTable(
  'batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierId: uuid('supplier_id').references(() => suppliers.id, { onDelete: 'set null' }),
    purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrders.id, {
      onDelete: 'set null',
    }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    status: batchStatusEnum('status').notNull().default('active'),
    qtyReceived: integer('qty_received').notNull().default(0),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('batches_product_idx').on(t.productId), index('batches_status_idx').on(t.status)],
);

export type Batch = typeof batches.$inferSelect;
export type NewBatch = typeof batches.$inferInsert;
