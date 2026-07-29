ALTER TABLE "sites" ADD COLUMN "plugin_version" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "plugin_version_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "note" text;