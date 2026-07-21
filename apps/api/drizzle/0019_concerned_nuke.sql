-- #7 (§8) Dinamik satış kotası + held_for_review. ADDITIVE + geriye dönük uyumlu.
-- NOT: 0013-0018 elle yazıldığı için drizzle snapshot'ı 0012'de kalmıştı; db:generate tüm
-- ara tabloları yeniden yaratmak istedi (drift). Bu dosya YALNIZ gerçekten yeni olan 5 kolon
-- + 1 kısmi index'i içerir. 0019 snapshot'ı tam güncel şemayı yakalar → drift buradan iyileşir.
-- IF NOT EXISTS defansif (migrator hash ile tek-sefer koşar; yine de kısmi durum güvencesi).
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "dynamic_quota_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "review_multiplier" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "held_for_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "held_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "held_reason" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_held_idx" ON "orders" USING btree ("created_at" DESC) WHERE "held_for_review" = true;
