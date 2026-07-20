ALTER TABLE "sites" ADD COLUMN "hmac_secret_prev_enc" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "hmac_secret_rotated_at" timestamp with time zone;