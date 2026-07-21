ALTER TABLE "license_items" ADD COLUMN "unit_cost_cents" integer;--> statement-breakpoint
ALTER TABLE "license_items" ADD COLUMN "cost_currency" text;--> statement-breakpoint
UPDATE "license_items" li SET "unit_cost_cents" = po."unit_cost_cents", "cost_currency" = po."currency" FROM "batches" b JOIN "purchase_orders" po ON po."id" = b."purchase_order_id" WHERE li."batch_id" = b."id" AND po."unit_cost_cents" IS NOT NULL;
