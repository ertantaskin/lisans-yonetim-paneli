-- #7 denetim M: orders_email_lower_idx schema.ts'e eklendi (0018'de vardı, modelde yoktu → drift).
-- Bu index PROD'da 0018 ile zaten mevcut → IF NOT EXISTS ile idempotent (prod no-op, taze DB oluşturur).
CREATE INDEX IF NOT EXISTS "orders_email_lower_idx" ON "orders" USING btree (lower("customer_email"));
