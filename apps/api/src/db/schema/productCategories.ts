import { sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * product_categories — ürün kategorileri (§12/§17, kullanıcı kararı: "ayrı Kategoriler ekranı").
 *
 * NEDEN AYRI TABLO (ürün üzerinde serbest metin DEĞİL): kullanıcı adı tek yerden yönetmek
 * istedi. Serbest metinde "Office" / "Ofis" / "office" ikiz kategoriler doğuyor ve ad
 * değiştirmek her üründe toplu güncelleme gerektiriyordu; burada ad TEK kayıttır, değişince
 * her yerde değişir ve ürün formunda YALNIZ listeden seçilir.
 *
 * `sortOrder`: operatörün belirlediği görüntüleme sırası (satış hacmi/alfabe değil — en çok
 * kullandığı kategoriyi öne alabilsin). Eşitlikte ada göre sıralanır → deterministik.
 */
export const productCategories = pgTable(
  'product_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Kartın altında görünen bir cümlelik açıklama (operatöre rehber). Opsiyonel. */
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  /**
   * Ad benzersizliği — TÜRKÇE-DUYARLI (dev'de ÖLÇÜLDÜ, düz `lower()` YETMİYOR):
   * en_US.utf8 collation'da `lower('WINDOWS LİSANSLARI')` = "windows lisanslari" ama
   * `lower('windows lisansları')` = "windows lisansları" → İKİSİ FARKLI sayılıyordu ve
   * "windows LİSANSLARI" ikinci kayıt olarak KABUL EDİLİYORDU (201). Oysa bu tablonun tek
   * varlık sebebi ikiz kategoriyi engellemek.
   *
   * `translate(name,'İIı','iii')` dört varyantı (i · ı · İ · I) tek karaktere indirger,
   * sonra `lower()` kalan harfleri (Ş/Ğ/Ç/Ö/Ü dahil — Unicode collation bunları doğru
   * çeviriyor, ölçüldü) küçültür. BİLİNÇLİ YAN ETKİ: "Sıra" ile "Sira" da çakışır —
   * Türkçe bir panelde bu iki ad zaten birbirine karıştırılacak isimlerdir.
   */
  (t) => [
    uniqueIndex('product_categories_name_lower_idx').on(
      sql`lower(translate(${t.name}, 'İIı', 'iii'))`,
    ),
  ],
);

export type ProductCategory = typeof productCategories.$inferSelect;
export type NewProductCategory = typeof productCategories.$inferInsert;
