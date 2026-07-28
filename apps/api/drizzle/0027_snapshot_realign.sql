-- 0027 — drizzle SNAPSHOT hizalaması (IDEMPOTENT; mevcut kurulumlarda tamamı NO-OP).
--
-- SORUN (denetim bulgusu): 0013-0018 ve 0021-0026 migration'ları ELLE yazıldı; drizzle meta
-- snapshot'ı 0020'de kalmıştı. Bu yüzden `pnpm db:generate` şemayı 0020 anlık görüntüsüyle
-- karşılaştırıp ARADA EKLENMİŞ HER ŞEYİ (deployments/replacement_messages/site_remote_products
-- tabloları, sites+order_lines+notifications kolonları, index'ler) "yeni" sanıyor ve bunları
-- yeniden yaratan bir migration üretiyordu. Böyle bir dosya prod'a giderse `CREATE TABLE
-- deployments` "already exists" ile patlar → API BOOT ETMEZ (auto-migrate boot'ta koşar).
--
-- ÇÖZÜM: bu dosya, drizzle'ın ürettiği farkın IDEMPOTENT hâlidir; yanındaki 0027_snapshot.json
-- ile snapshot ARTIK ŞEMANIN TAMAMINI yakalar → bundan sonra `db:generate` BOŞ fark üretir.
--
-- Her ifade "zaten varsa atla" biçimindedir:
--   · mevcut kurulumlarda (prod/dev/test) hepsi ZATEN VAR → tam no-op,
--   · sıfırdan kurulan bir DB'de 0000-0026 zaten hepsini yaratmıştır → yine no-op.
-- Yani veri/şema DEĞİŞMEZ; tek amaç meta snapshot'ı gerçekle hizalamak.
--
-- AYRICA (aynı bulgunun ikinci yarısı): 0025'te ELLE yazılan 5 index şema dosyalarında tanımlı
-- değildi (schema.ts tek doğruluk kaynağı olmaktan çıkmıştı) → license_items_*_idx ve
-- replacement_requests_created_idx artık src/db/schema/*.ts içinde de tanımlı.
CREATE TABLE IF NOT EXISTS "replacement_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"author_type" text NOT NULL,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"git_sha" text,
	"log" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_remote_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"remote_product_id" text NOT NULL,
	"remote_variation_id" text,
	"name" text NOT NULL,
	"sku" text,
	"kind" text,
	"active" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "admin_order_url_template" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "admin_order_url_template_manual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "remote_product_id" text;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "remote_variation_id" text;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "remote_name" text;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "bundle_qty" integer;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "read_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'replacement_messages_request_id_replacement_requests_id_fk') THEN
		ALTER TABLE "replacement_messages" ADD CONSTRAINT "replacement_messages_request_id_replacement_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."replacement_requests"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_remote_products_site_id_sites_id_fk') THEN
		ALTER TABLE "site_remote_products" ADD CONSTRAINT "site_remote_products_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "replacement_messages_request_idx" ON "replacement_messages" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployments_created_idx" ON "deployments" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployments_status_idx" ON "deployments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "site_remote_products_uniq" ON "site_remote_products" USING btree ("site_id","remote_product_id","remote_variation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "site_remote_products_site_idx" ON "site_remote_products" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "license_items_created_idx" ON "license_items" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "license_items_status_created_idx" ON "license_items" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "license_items_assigned_idx" ON "license_items" USING btree ("assigned_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "license_items_batch_idx" ON "license_items" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "replacement_requests_created_idx" ON "replacement_requests" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_unread_idx" ON "notifications" USING btree ("created_at" DESC NULLS LAST) WHERE "notifications"."read_at" IS NULL;
