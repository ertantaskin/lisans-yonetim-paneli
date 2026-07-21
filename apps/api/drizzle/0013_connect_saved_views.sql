CREATE TABLE "site_connect_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"api_key_enc" text,
	"hmac_secret_enc" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"page" text NOT NULL,
	"name" text NOT NULL,
	"query" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "site_connect_tokens_code_idx" ON "site_connect_tokens" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "site_connect_tokens_site_idx" ON "site_connect_tokens" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "saved_views_actor_page_idx" ON "saved_views" USING btree ("actor","page","created_at");