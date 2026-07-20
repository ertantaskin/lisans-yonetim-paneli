CREATE TYPE "public"."replacement_status" AS ENUM('open', 'info_requested', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "replacement_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"line_id" uuid,
	"assignment_id" uuid,
	"customer_email" text NOT NULL,
	"reason" text NOT NULL,
	"status" "replacement_status" DEFAULT 'open' NOT NULL,
	"within_warranty" boolean DEFAULT false NOT NULL,
	"resolution_note" text,
	"new_assignment_id" uuid,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_line_id_order_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."order_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "replacement_requests_status_idx" ON "replacement_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "replacement_requests_email_idx" ON "replacement_requests" USING btree ("customer_email");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_email_uniq" ON "customers" USING btree ("email");