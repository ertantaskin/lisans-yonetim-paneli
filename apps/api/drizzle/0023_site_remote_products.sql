-- Mağaza ürün kataloğu snapshot'ı (site_remote_products) — WP eklentisinden senkronlanır (§3).
-- Amaç: panelde PROAKTİF eşleme (sipariş gelmeden mağaza ürününü adıyla seç → panel ürününe eşle).
-- SIR YOK (ad/sku/tip). Eşleme ayrı tabloda (site_product_mappings). Additive — mevcut akış etkilenmez.
CREATE TABLE IF NOT EXISTS "site_remote_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
	"remote_product_id" text NOT NULL,
	"remote_variation_id" text,
	"name" text NOT NULL,
	"sku" text,
	"kind" text,
	"active" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "site_remote_products_uniq" ON "site_remote_products" USING btree ("site_id","remote_product_id","remote_variation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "site_remote_products_site_idx" ON "site_remote_products" USING btree ("site_id");
