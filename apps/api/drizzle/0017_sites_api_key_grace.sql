ALTER TABLE "sites" ADD COLUMN "api_key_hash_prev" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "api_key_rotated_at" timestamp with time zone;