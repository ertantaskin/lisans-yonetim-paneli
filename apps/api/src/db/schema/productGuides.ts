import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * product_guides — kurulum / etkinleştirme rehberleri (§7 teslimat deneyimi).
 *
 * NEDEN AYRI TABLO (ürün üzerinde tek metin kolonu DEĞİL): bir rehber ÇOK ÜRÜNE hizmet
 * eder. "Office 2021 etkinleştirme" anlatısı Pro Plus / Home & Business / tek-PC gibi
 * onlarca SKU'da aynıdır; metni ürüne gömmek, tek bir adım değişince onlarca ürünü elle
 * güncellemek demektir (ve biri unutulunca müşteriye YANLIŞ talimat gider). Burada rehber
 * TEK kayıttır, düzeltilince bağlı tüm ürünlerde anında düzelir.
 *
 * Ürün bağı `products.guide_id` üzerinden ve `ON DELETE SET NULL` ile kurulur:
 * rehber silinince ÜRÜN SİLİNMEZ, yalnız rehbersiz kalır (kategori tablosuyla aynı karar).
 *
 * İÇERİK SIR DEĞİLDİR: rehber metni müşteriye giden genel talimattır (lisans anahtarı
 * ASLA buraya yazılmaz — anahtar `license_items.payload_enc` içinde şifrelidir). Bu yüzden
 * şifreleme/maskeleme yoktur; buna karşılık metin müşterinin tarayıcısında render edildiği
 * için HTML'e çevrim GÜVENLİ alt kümeyle yapılır (packages/shared → renderGuideHtml).
 */
export const productGuides = pgTable(
  'product_guides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Operatörün seçtiği ad — ürün formundaki açılır listede görünür. */
    title: text('title').notNull(),
    /** Rehber metni (mini-biçimleme: numaralı adım / madde / başlık / kalın / bağlantı). */
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  /**
   * Başlık benzersizliği — TÜRKÇE-DUYARLI, `product_categories` ile BİREBİR aynı ifade.
   *
   * Gerekçe orada ölçülerek belgelendi: en_US.utf8 collation'da düz `lower()` İ/I/ı/i
   * dört varyantını ayrı sayar → "OFFICE 365 KURULUMU" ikinci kayıt olarak kabul edilirdi.
   * Burada da aynı sonucu doğurur: ürün formunda operatör iki özdeş başlık görür ve
   * hangisini seçtiğini BİLEMEZ (seçim yalnız başlıkla yapılıyor).
   */
  (t) => [
    uniqueIndex('product_guides_title_lower_idx').on(
      sql`lower(translate(${t.title}, 'İIı', 'iii'))`,
    ),
  ],
);

export type ProductGuideRecord = typeof productGuides.$inferSelect;
export type NewProductGuide = typeof productGuides.$inferInsert;
