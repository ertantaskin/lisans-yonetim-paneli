-- Saklama/budama (retention) sıcak-yol index'leri (additive, IDEMPOTENT).
-- RetentionService created_at'e göre eski satırları batch'ler halinde budar/maskeler; bu
-- index'ler olmadan her prune tam-tablo tarar. Yalnız EKSİK olanlar eklenir — audit_log
-- (audit_log_created_idx), security_events (security_events_created_idx) ve outbox_events
-- (outbox_status_idx = status,created_at) index'leri ZATEN mevcut (0000/0003/0010).
CREATE INDEX IF NOT EXISTS "fulfillment_events_created_idx" ON "fulfillment_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_log_created_idx" ON "email_log" USING btree ("created_at");
