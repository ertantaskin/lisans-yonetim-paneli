CREATE INDEX IF NOT EXISTS "assignment_history_assignment_idx" ON "assignment_history" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignment_history_old_item_idx" ON "assignment_history" USING btree ("old_license_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignments_created_idx" ON "assignments" USING btree ("created_at");