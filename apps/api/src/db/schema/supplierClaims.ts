import { sql } from 'drizzle-orm';
import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { suppliers } from './suppliers';

/**
 * supplier_claim_status — tedarikçiye kesilen "değişim fişi"nin yaşam döngüsü (§12).
 * draft (hazırlandı, henüz gönderilmedi) → sent (tedarikçiye iletildi) → closed (kapandı)
 * · canceled (yanlış kesildi, YALNIZ draft iken).
 *
 * Enum bu dosyada durur (replacement_requests deseni); `schema/enums.ts` yalnız orkestratör
 * dosyasıdır ve oraya taşımak dosyalar arası döngüsel bağımlılık davet eder.
 */
export const supplierClaimStatusEnum = pgEnum('supplier_claim_status', [
  'draft',
  'sent',
  'closed',
  'canceled',
]);

/**
 * supplier_claim_outcome — fişteki TEK BİR anahtarın tedarikçi yanıtı.
 * pending (cevap bekleniyor) · replaced (yenisi geldi) · credited (bedeli iade/mahsup edildi)
 * · rejected (tedarikçi kabul etmedi).
 *
 * KRİTİK: `rejected` "bu iş bitti" DEĞİL, "bu anahtar HAVUZA GERİ DÖNDÜ" demektir — aşağıdaki
 * kısmi unique index tam olarak bu değeri dışarıda bırakır, böylece reddedilen anahtar yeniden
 * bildirilebilir (kullanıcının açık kararı).
 */
export const supplierClaimOutcomeEnum = pgEnum('supplier_claim_outcome', [
  'pending',
  'replaced',
  'credited',
  'rejected',
]);

/**
 * supplier_claims — kusurlu anahtarların tedarikçiye toplu bildirimi ("değişim fişi", §12).
 *
 * NEDEN VAR: panelde "bu kusurlu anahtarı tedarikçiye bildirdim mi?" bilgisini tutan HİÇBİR
 * alan yoktu. Tek "bildirim" mekanizması izi olmayan bir tarayıcı indirmesiydi → aynı anahtar
 * defalarca bildirilebiliyor, hangi partinin zaten gönderildiği bilinemiyor, tedarikçinin yanıtı
 * hiçbir yere yazılmıyordu.
 *
 * Fiş bir "Z raporu"dur: seçilen tarih penceresinde biriken, HENÜZ BİLDİRİLMEMİŞ kusurlular tek
 * seferde donar (`period_from`/`period_to` o pencereyi saklar) ve bir daha havuzda görünmez.
 *
 * `supplier_id` ON DELETE SET NULL: tedarikçi kaydı silinse bile fiş geçmişi (ve indirdiğin
 * rapor) kaybolmamalı. Uygulama zaten silme yerine `active=false` tercih ediyor.
 */
export const supplierClaims = pgTable(
  'supplier_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** İnsan-okunur fiş no: DEG-20260813-01. Tedarikçiyle yazışmada referans budur. */
    code: text('code').notNull(),
    supplierId: uuid('supplier_id').references(() => suppliers.id, { onDelete: 'set null' }),
    status: supplierClaimStatusEnum('status').notNull().default('draft'),
    /** Z raporunun kapsadığı pencere (bilgi amaçlı — kalem seçimi zaten donmuştur). */
    periodFrom: timestamp('period_from', { withTimezone: true }),
    periodTo: timestamp('period_to', { withTimezone: true }),
    /** Operatör notu (tedarikçiye iletilen açıklama). */
    note: text('note'),
    /** Tedarikçinin KENDİ talep/ticket numarası — yazışmayı eşlemek için. */
    reference: text('reference'),
    /** Fiş kesilirken donmuş kalem sayısı (liste ekranı JOIN'siz okusun). */
    itemCount: integer('item_count').notNull().default(0),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    // Fiş no benzersiz: aynı numara iki kez üretilirse tedarikçiyle yazışma karışır.
    uniqueIndex('supplier_claims_code_uniq').on(t.code),
    index('supplier_claims_supplier_idx').on(t.supplierId),
    index('supplier_claims_status_idx').on(t.status),
    index('supplier_claims_created_idx').on(t.createdAt.desc(), t.id.desc()),
  ],
);

/**
 * supplier_claim_items — fişteki tek bir kusurlu anahtar.
 *
 * `license_item_id` BİLEREK PLAIN uuid (FK YOK) — `stock_adjustments` deseni: kalem hard-delete
 * edilse bile fiş izi (ve tedarikçiye gönderilmiş rapor) ayakta kalır, ayrıca bu modül
 * `license_items` şemasına build-bağımlılığı kurmaz (tedarik tarafı RAW SQL ile dokunur).
 *
 * SNAPSHOT ALANLARI (batch_label / product_name / sku / key_snapshot / reason / defect_kind /
 * quarantined_at): fiş kesildiği ANDAKİ gerçeği dondurur. Sebep: tedarikçiye gönderdiğin dosya
 * ile panelde bir ay sonra gördüğün fiş BİREBİR aynı olmalı — ürün adı değişse, parti silinse ya
 * da sebep metni güncellense bile rapor kaymamalı.
 */
export const supplierClaimItems = pgTable(
  'supplier_claim_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => supplierClaims.id, { onDelete: 'cascade' }),
    /** license_items.id — PLAIN, FK YOK (yukarıdaki nota bak). */
    licenseItemId: uuid('license_item_id').notNull(),
    productId: uuid('product_id'),
    batchId: uuid('batch_id'),
    // ── Snapshot ──
    batchLabel: text('batch_label'),
    productName: text('product_name'),
    sku: text('sku'),
    /**
     * Anahtarın fiş anındaki gösterimi. Hesap ürünlerinde YALNIZ sır-olmayan alanlar
     * (parola asla); key ürünlerinde düz anahtar — tedarikçi zaten onu tanımak zorunda.
     */
    keySnapshot: text('key_snapshot'),
    reason: text('reason'),
    /**
     * Kusurun KAYNAĞI: 'customer_return' (müşteri iadesi/değişimi) · 'manual_void' (elle
     * geçersiz kılma) · 'damage' (hasarlı işaretleme) · 'recall' (parti geri çekme).
     * Metin (enum değil): yeni bir ölüm yolu eklenirse migration gerekmesin. Tedarikçiye giden
     * raporda gerekçe ayrımı bununla yazılır.
     */
    defectKind: text('defect_kind'),
    quarantinedAt: timestamp('quarantined_at', { withTimezone: true }),
    // ── Sonuç ──
    outcome: supplierClaimOutcomeEnum('outcome').notNull().default('pending'),
    outcomeNote: text('outcome_note'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('supplier_claim_items_claim_idx').on(t.claimId),
    index('supplier_claim_items_batch_idx').on(t.batchId),
    /**
     * ÇİFT BİLDİRİMİ DB DÜZEYİNDE ENGELLEYEN TEK SATIR.
     *
     * Bir anahtar aynı anda yalnız TEK açık/çözülmüş fişte olabilir. `rejected` hariç tutulur:
     * tedarikçi reddettiyse anahtar havuza geri döner ve YENİDEN bildirilebilir (kullanıcı
     * kararı). Uygulama katmanı da aynı kontrolü yapar ama asıl güvence budur — eşzamanlı iki
     * fiş isteği aynı kalemi paylaşamaz.
     */
    uniqueIndex('supplier_claim_items_open_uniq')
      .on(t.licenseItemId)
      .where(sql`${t.outcome} <> 'rejected'`),
  ],
);

export type SupplierClaim = typeof supplierClaims.$inferSelect;
export type NewSupplierClaim = typeof supplierClaims.$inferInsert;
export type SupplierClaimItem = typeof supplierClaimItems.$inferSelect;
export type NewSupplierClaimItem = typeof supplierClaimItems.$inferInsert;
