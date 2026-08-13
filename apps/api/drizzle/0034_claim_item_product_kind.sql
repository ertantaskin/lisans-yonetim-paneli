ALTER TABLE "supplier_claim_items" ADD COLUMN "product_kind" text;--> statement-breakpoint
-- Mevcut fişler için geriye dönük doldurma: ürün tipi ürün kaydından okunur.
-- (Yeni satırlarda tip fiş kesilirken SNAPSHOT'lanır; bu UPDATE yalnız 0034 öncesi
--  satırlar içindir. Ürünü silinmiş kalem NULL kalır → ekran nötr "kalem" diline düşer.)
UPDATE "supplier_claim_items" sci
   SET "product_kind" = p."kind"::text
  FROM "products" p
 WHERE p."id" = sci."product_id"
   AND sci."product_kind" IS NULL;
