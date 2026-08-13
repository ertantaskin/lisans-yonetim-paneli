ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "canceled_units" integer DEFAULT 0 NOT NULL;
