CREATE TYPE "public"."assignment_status" AS ENUM('active', 'suspended', 'replaced', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('reveal', 'replace', 'revoke', 'suspend', 'unsuspend', 'import', 'login', 'assign', 'resend');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_policy" AS ENUM('partial-auto', 'partial-approval', 'all-or-nothing');--> statement-breakpoint
CREATE TYPE "public"."license_item_status" AS ENUM('available', 'assigned', 'suspended', 'replaced', 'revoked', 'quarantined', 'depleted', 'expired', 'voided');--> statement-breakpoint
CREATE TYPE "public"."on_expiry" AS ENUM('hide', 'keep');--> statement-breakpoint
CREATE TYPE "public"."order_line_status" AS ENUM('pending', 'partial', 'fulfilled');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('unmapped', 'pending', 'partial', 'fulfilled', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."product_kind" AS ENUM('key', 'account', 'custom', 'code');--> statement-breakpoint
CREATE TYPE "public"."purchase_order_status" AS ENUM('ordered', 'partially_received', 'received', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."site_type" AS ENUM('woocommerce', 'marketplace', 'reseller');--> statement-breakpoint
CREATE TYPE "public"."usage_mode" AS ENUM('single', 'multi');--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "site_type" DEFAULT 'woocommerce' NOT NULL,
	"domain" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"hmac_secret_enc" text NOT NULL,
	"sender_email" text,
	"sender_domain_verified" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"kind" "product_kind" DEFAULT 'key' NOT NULL,
	"payload_schema" jsonb,
	"usage_mode" "usage_mode" DEFAULT 'single' NOT NULL,
	"max_uses" integer,
	"validity_days" integer,
	"on_expiry" "on_expiry" DEFAULT 'hide' NOT NULL,
	"stockless" boolean DEFAULT false NOT NULL,
	"release_at" timestamp with time zone,
	"fulfillment_policy" "fulfillment_policy" DEFAULT 'partial-auto' NOT NULL,
	"warranty_days" integer,
	"key_format" text,
	"low_stock_threshold" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"batch_id" uuid,
	"payload_enc" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload_suffix_hash" text,
	"expires_at" timestamp with time zone,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"status" "license_item_status" DEFAULT 'available' NOT NULL,
	"assigned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"remote_line_id" text NOT NULL,
	"qty" integer NOT NULL,
	"fulfilled_qty" integer DEFAULT 0 NOT NULL,
	"status" "order_line_status" DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"remote_order_id" text NOT NULL,
	"customer_email" text NOT NULL,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"old_license_item_id" uuid,
	"new_license_item_id" uuid,
	"reason" text NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"license_item_id" uuid NOT NULL,
	"units" integer DEFAULT 1 NOT NULL,
	"valid_until" timestamp with time zone,
	"status" "assignment_status" DEFAULT 'active' NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" "audit_action" NOT NULL,
	"actor" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"meta" jsonb,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "license_items" ADD CONSTRAINT "license_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_history" ADD CONSTRAINT "assignment_history_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_line_id_order_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_license_item_id_license_items_id_fk" FOREIGN KEY ("license_item_id") REFERENCES "public"."license_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "products_sku_uniq" ON "products" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "license_items_payload_hash_uniq" ON "license_items" USING btree ("payload_hash");--> statement-breakpoint
CREATE INDEX "license_items_available_idx" ON "license_items" USING btree ("product_id","created_at") WHERE "license_items"."status" = 'available';--> statement-breakpoint
CREATE INDEX "license_items_fefo_idx" ON "license_items" USING btree ("product_id","expires_at") WHERE "license_items"."status" = 'available';--> statement-breakpoint
CREATE INDEX "license_items_suffix_idx" ON "license_items" USING btree ("payload_suffix_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency_key_uniq" ON "orders" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_site_remote_uniq" ON "orders" USING btree ("site_id","remote_order_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");