CREATE TYPE "public"."supplier_claim_outcome" AS ENUM('pending', 'replaced', 'credited', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."supplier_claim_status" AS ENUM('draft', 'sent', 'closed', 'canceled');--> statement-breakpoint
CREATE TABLE "supplier_claim_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"license_item_id" uuid NOT NULL,
	"product_id" uuid,
	"batch_id" uuid,
	"batch_label" text,
	"product_name" text,
	"sku" text,
	"key_snapshot" text,
	"reason" text,
	"defect_kind" text,
	"quarantined_at" timestamp with time zone,
	"outcome" "supplier_claim_outcome" DEFAULT 'pending' NOT NULL,
	"outcome_note" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"supplier_id" uuid,
	"status" "supplier_claim_status" DEFAULT 'draft' NOT NULL,
	"period_from" timestamp with time zone,
	"period_to" timestamp with time zone,
	"note" text,
	"reference" text,
	"item_count" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "supplier_claim_items" ADD CONSTRAINT "supplier_claim_items_claim_id_supplier_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."supplier_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_claims" ADD CONSTRAINT "supplier_claims_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_claim_items_claim_idx" ON "supplier_claim_items" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "supplier_claim_items_batch_idx" ON "supplier_claim_items" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_claim_items_open_uniq" ON "supplier_claim_items" USING btree ("license_item_id") WHERE "supplier_claim_items"."outcome" <> 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_claims_code_uniq" ON "supplier_claims" USING btree ("code");--> statement-breakpoint
CREATE INDEX "supplier_claims_supplier_idx" ON "supplier_claims" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_claims_status_idx" ON "supplier_claims" USING btree ("status");--> statement-breakpoint
CREATE INDEX "supplier_claims_created_idx" ON "supplier_claims" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stock_adjustments_license_item_idx" ON "stock_adjustments" USING btree ("license_item_id");