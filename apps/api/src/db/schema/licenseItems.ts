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
     * liste ekranda KARIŞIK görünüyordu. `seq` ekleme sırasını taşır.
     *
     * LİSTELEME `created_at DESC, seq DESC` (kullanıcı kararı): satır satır en yeni üstte —
     * `test1, test2` girildiyse `test2` üstte. TESLİMAT bunun TERSİ (`seq ASC`, aşağıda).
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
    // ATAMA SORGUSUNUN TAM KARŞILIĞI (denetim/perf bulgusu) — sistemin en sıcak yazma yolu.
    // `assignAvailableSingleUse` / `consumeMultiUseCapacity` şu sırayla seçer:
    //   WHERE product_id=? AND status='available' AND (expires_at IS NULL OR expires_at>now())
    //   ORDER BY expires_at ASC NULLS LAST, created_at, seq  LIMIT n  FOR UPDATE SKIP LOCKED
    // Eski `_fefo_idx` yalnız (product_id, expires_at) taşıyordu; `created_at`/`seq` indekste
    // OLMADIĞI için sıralama anahtarlarını okumak üzere her aday satır için heap'e gidiliyordu.
    // Üstelik kalemlerin ezici çoğunluğunda `expires_at IS NULL` olduğundan presorted prefix
    // TEK dev gruba düşüyor, yani LIMIT devreye girmeden o ürünün TÜM available satırları
    // sıralanıyordu (0030'da `seq` tie-break'i eklenmişti, indeksi eklenmemişti — regresyon
    // buradan doğdu). Dört kolon birlikte olduğunda tarama LIMIT kadar indeks girdisinde durur.
    //
    // `_fefo_idx` DÜŞÜRÜLDÜ: bu indeksin ÖN EKİ (product_id, expires_at) ve kısmi koşulu
    // birebir aynı → her planı bu index de karşılar. license_items her stok girişinde ve her
    // atamada yazıldığı için kesinlikle gereksiz bir indeksi taşımak yazma maliyetidir.
    index('license_items_alloc_idx')
      .on(t.productId, t.expiresAt, t.createdAt, t.seq)
      .where(sql`${t.status} = 'available'`),
    // Son 5 hane araması.
    index('license_items_suffix_idx').on(t.payloadSuffixHash),
    // Envanter ekranı sıcak yolu (0025 — elle yazılmıştı, şemaya taşındı ki `db:generate`
    // bir daha drift üretmesin). Yalın `created_at DESC` sıralamalarına hizmet eder.
    // NOT: envanterin İKİ sıralama seçeneği de artık AŞAĞIDAKİ `_asc_idx`'ten karşılanıyor
    // (bkz. yorum); bu index ONLARIN yolunda DEĞİL. Bırakıldı: düşürmek migration ister,
    // faydası yazma maliyetinden düşük ama sıfır risk değil.
    index('license_items_created_idx').on(t.createdAt.desc(), t.seq.asc()),
    // ENVANTERİN İKİ SIRALAMASINI DA BU index karşılar — btree geriye taraması TÜM
    // kolonların yönünü birden çevirdiği için:
    //   ileri  → `(created_at ASC,  seq ASC)`  = "En eski giriş üstte"
    //   geriye → `(created_at DESC, seq DESC)` = varsayılan "En yeni giriş üstte"
    // (Tek başına `(created_at DESC, seq ASC)` index'i İKİSİNİ DE veremez: geriye taraması
    // `(ASC, DESC)` üretir, bu ne "en yeni" ne "en eski" sıralamasıdır.)
    index('license_items_created_asc_idx').on(t.createdAt.asc(), t.seq.asc()),
    // ÜRÜNE göre envanter (ürün detayı + `/stock/import` önizleme + `?product=` süzgeci).
    // Buraya kadar `product_id` üzerinde KOŞULSUZ index YOKTU: mevcut ikisi de
    // `WHERE status='available'` KISMİ index'i (available_idx / fefo_idx), yani "bu ürünün
    // TÜM kalemleri" (teslim edilmiş + karantina dahil) sorgusu tam tablo taraması yapıyordu.
    // Sıralama kolonlarını da taşır: `WHERE product_id = ? ORDER BY created_at DESC, seq DESC`
    // eşitlikle sabitlenmiş ilk kolondan sonra GERİYE taramayla karşılanır.
    index('license_items_product_created_idx').on(t.productId, t.createdAt, t.seq),
    index('license_items_status_created_idx').on(t.status, t.createdAt.desc()),
    // KUSURLU STOK (/quarantine) sıralaması — `ORDER BY coalesce(assigned_at, created_at) DESC,
    // seq DESC`. Bu bir İFADE'dir, hiçbir kolon indeksi karşılamaz → karantina/void kümesinin
    // TAMAMI materyalize edilip sıralanıyordu (üstelik payload_enc dahil geniş satırlarla ve
    // 7 LEFT JOIN fan-out'uyla; work_mem aşılırsa disk sort). Küme KÜMÜLATİF: kusurlu anahtar
    // silinmiyor, retention da budamıyor → sürekli büyür.
    // İfade indeksi olduğu için sorgudaki ifade BİREBİR aynı yazılmalıdır (`coalesce(...)`).
    index('license_items_dead_at_idx')
      .on(sql`coalesce(${t.assignedAt}, ${t.createdAt}) DESC`, t.seq.desc())
      .where(sql`${t.status} IN ('quarantined', 'voided')`),
    index('license_items_assigned_idx').on(sql`${t.assignedAt} DESC NULLS LAST`),
    index('license_items_batch_idx').on(t.batchId),
  ],
);

export type LicenseItem = typeof licenseItems.$inferSelect;
export type NewLicenseItem = typeof licenseItems.$inferInsert;
