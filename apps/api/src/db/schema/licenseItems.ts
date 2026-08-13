import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
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

    /**
     * COGS maliyet anlık-görüntüsü (§12, D17). Import anında bağlı partinin PO'sundan
     * kopyalanır ve BİR DAHA DEĞİŞMEZ (snapshot). batch_id yoksa veya PO maliyeti
     * yoksa NULL kalır — teslim COGS'ta "uncovered" olarak AYRI sayılır.
     */
    unitCostCents: integer('unit_cost_cents'),
    costCurrency: text('cost_currency'),

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

    /**
     * EKLEME SIRASI — monoton artan (sequence). Listelemede `created_at`'in tie-break'i.
     *
     * NEDEN GEREKLİ: bir içe aktarmanın TÜM satırları tek transaction'da yazılır, bu yüzden
     * `now()` (transaction başlangıcı) hepsinde AYNIDIR — dev'de ölçüldü: 15 satırlık giriş
     * tek damga. Eski tie-break `id DESC` idi ve `id` rastgele UUID v4 → operatörün girdiği
     * liste ekranda KARIŞIK görünüyordu. `seq` ekleme sırasını taşır; sıralama
     * `created_at DESC, seq ASC` olunca "en yeni giriş üstte, blok içinde yapıştırılan sıra"
     * elde edilir.
     *
     * FIFO: atama sorgusu da (`assignment/assign.ts`) bu kolonla tie-break yapar → aynı
     * partide önce girilen anahtar önce teslim edilir (eskiden rastgeleydi).
     *
     * GEÇMİŞ SATIRLAR: kolon eklenirken değerler tablonun FİZİKSEL sırasına göre dolar; bu
     * genelde ekleme sırasına yakındır ama GARANTİ DEĞİLDİR (UPDATE görmüş satırlar yer
     * değiştirmiş olabilir). Kolon eklendikten SONRAKİ girişlerde sıra kesindir.
     */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
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
    // Envanter ekranı sıcak yolları (0025 — elle yazılmıştı, şemaya taşındı ki `db:generate`
    // bir daha drift üretmesin). Tie-break artık `seq` (ekleme sırası): sayfalar arasında
    // satır yer değiştirmez VE aynı içe aktarmadaki satırlar operatörün girdiği sırada kalır
    // (eski `id DESC` tie-break'i sayfalamayı sabitliyordu ama sırayı RASTGELE yapıyordu).
    index('license_items_created_idx').on(t.createdAt.desc(), t.seq.asc()),
    // "En eski giriş üstte" (`created_asc`) için AYRI index — ŞART.
    // `(created_at DESC, seq ASC)` btree'sini GERİYE taramak `(created_at ASC, seq DESC)`
    // verir; istediğimiz `(created_at ASC, seq ASC)` DEĞİL. Yönler ayna olmadığı için tek
    // index iki sıralamayı karşılayamaz. Bu index olmadan "En eski" seçeneği index desteğini
    // KAYBEDERDİ (eski `(created_at DESC, id DESC)` geriye taramayla karşılıyordu) — büyük
    // tabloda tam sıralama demek. Maliyeti düşük: iki dar kolon.
    index('license_items_created_asc_idx').on(t.createdAt.asc(), t.seq.asc()),
    index('license_items_status_created_idx').on(t.status, t.createdAt.desc()),
    index('license_items_assigned_idx').on(sql`${t.assignedAt} DESC NULLS LAST`),
    index('license_items_batch_idx').on(t.batchId),
  ],
);

export type LicenseItem = typeof licenseItems.$inferSelect;
export type NewLicenseItem = typeof licenseItems.$inferInsert;
