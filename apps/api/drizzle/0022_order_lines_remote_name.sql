-- Mağaza ürün kimliği + adı (sipariş push'unda gelir) — order_lines'a eklenir.
-- Amaç: (1) eşleştirme doğrulaması, (2) "eşlenmemiş gelen ürünler" ekranı (hangi mağaza ürünü
-- geldi ama eşli değil, tek-tıkla eşle), (3) izlenebilirlik. Additive + nullable (eski satırlar
-- + eski eklenti NULL kalır, geriye dönük uyumlu — teslimat mantığını etkilemez).
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "remote_product_id" text;
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "remote_variation_id" text;
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "remote_name" text;
