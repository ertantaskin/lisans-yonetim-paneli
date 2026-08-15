CREATE TABLE "product_guides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "guide_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "product_guides_title_lower_idx" ON "product_guides" USING btree (lower(translate("title", 'İIı', 'iii')));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_guide_id_product_guides_id_fk" FOREIGN KEY ("guide_id") REFERENCES "public"."product_guides"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_guide_idx" ON "products" USING btree ("guide_id");