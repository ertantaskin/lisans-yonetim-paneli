CREATE INDEX IF NOT EXISTS "assignments_order_idx" ON "assignments" USING btree ("order_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignments_line_idx" ON "assignments" USING btree ("line_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignments_license_item_idx" ON "assignments" USING btree ("license_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_lines_order_idx" ON "order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_lines_pending_product_idx" ON "order_lines" USING btree ("product_id") WHERE "order_lines"."status" IN ('pending', 'partial') AND "order_lines"."canceled" = false;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_created_idx" ON "orders" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_site_created_idx" ON "orders" USING btree ("site_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_email_lower_idx" ON "orders" USING btree (lower("customer_email"));
