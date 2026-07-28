-- İş istasyonu dalgası (§12/§13/§17) — hepsi ADDITIVE, mevcut akış etkilenmez.
--  1) notifications.read_at  → üst bardaki bildirim çanı "okunmamış" sayacı (global okuma durumu).
--  2) replacement_messages   → destek talebinde çift yönlü yazışma (admin ↔ müşteri) + suistimal izi.
--  3) sites.admin_order_url_template → mağaza admin panelinde siparişi AÇMAK için URL şablonu
--     (yalnız link üretir; otomatik bağlantı/oturum YOK — §7 güvenlik gereği salt yönlendirme).

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "read_at" timestamp with time zone;
--> statement-breakpoint
-- Okunmamış sayacı sıcak yol: yalnız okunmamışlar indexlenir (partial → index küçük kalır).
CREATE INDEX IF NOT EXISTS "notifications_unread_idx" ON "notifications" USING btree ("created_at" DESC) WHERE "read_at" IS NULL;
--> statement-breakpoint

ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "admin_order_url_template" text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "replacement_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL REFERENCES "replacement_requests"("id") ON DELETE cascade,
	-- 'admin' | 'customer' | 'system' — kimin yazdığı (yetki imza/oturumdan, gövdeden DEĞİL).
	"author_type" text NOT NULL,
	-- Görünen ad (admin kullanıcı adı / 'Müşteri' / 'Sistem'). Sır ASLA yazılmaz.
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	-- Müşteriye gösterilmeyen iç not (admin↔admin). false ise müşteri de görür.
	"internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "replacement_messages_request_idx" ON "replacement_messages" USING btree ("request_id","created_at");
