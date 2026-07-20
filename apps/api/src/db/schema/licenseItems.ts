import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { licenseItemStatusEnum } from './enums';
import { products } from './products';

/**
 * license_items — şifreli lisans havuzu (§3). Sistemin kalbi: atomik atama
 * (FOR UPDATE SKIP LOCKED) bu tablo üzerinde döner.
 *
 * payload_enc: AES-256-GCM envelope (Faz 1'de dolar; Faz 0'da düz text kolonu hazır).
 * payload_hash: mükerrer key engeli (UNIQUE).
 * payload_suffix_hash: son 5 hane araması (Ctrl+K, §13).
 */
export const licenseItems = pgTable(
  'license_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    batchId: uuid('batch_id'),

    payloadEnc: text('payload_enc').notNull(),
    payloadHash: text('payload_hash').notNull(),
    payloadSuffixHash: text('payload_suffix_hash'),

    /** Stok ömrü (FEFO — önce ölecek satılır). validity_days'ten AYRI kavram. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    /** Çok kullanımlık (multi) kapasitesi. single'da max_uses=1. */
    maxUses: integer('max_uses').notNull().default(1),
    useCount: integer('use_count').notNull().default(0),

    status: licenseItemStatusEnum('status').notNull().default('available'),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // Mükerrer key imkânsız.
    uniqueIndex('license_items_payload_hash_uniq').on(t.payloadHash),
    // KRİTİK: partial index — 10M satırda bile "available" alt kümesi küçük kalır.
    // Atomik atamanın SELECT ... WHERE status='available' ORDER BY created_at
    // kısmı bu index üzerinden gider.
    index('license_items_available_idx')
      .on(t.productId, t.createdAt)
      .where(sql`${t.status} = 'available'`),
    // FEFO taraması.
    index('license_items_fefo_idx')
      .on(t.productId, t.expiresAt)
      .where(sql`${t.status} = 'available'`),
    // Son 5 hane araması.
    index('license_items_suffix_idx').on(t.payloadSuffixHash),
  ],
);

export type LicenseItem = typeof licenseItems.$inferSelect;
export type NewLicenseItem = typeof licenseItems.$inferInsert;
