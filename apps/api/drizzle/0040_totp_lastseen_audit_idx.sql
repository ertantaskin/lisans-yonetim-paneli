-- Üç ADDITIVE değişiklik (tek migration — üç ayrı işçi eşzamanlı migration üretse drizzle
-- journal dosyasında çakışırdı; şema değişiklikleri bilerek tek elde toplandı).
--
-- IDEMPOTENT (`IF NOT EXISTS`): migration boot'ta koşar; yarıda kalmış bir uygulamadan sonra
-- çıplak ADD COLUMN / CREATE INDEX "already exists" ile patlar ve API HİÇ AÇILMAZ.
--
-- 1) admin_users.totp_secret_enc / totp_enabled — iki faktörlü giriş (§8).
--    Sır AES-256-GCM envelope ile ŞİFRELİ yazılır (payload'larla aynı kasa). `totp_enabled`
--    ayrı bayrak: kullanıcı ilk kodu DOĞRULAYANA kadar false kalır, yoksa hatalı kurulumda
--    hesap kendini kilitlerdi. Mevcut adminler etkilenmez (varsayılan false = eski davranış).
-- 2) sites.last_seen_at — mağaza canlılığı. `plugin_version_at` yalnız SÜRÜM değişince,
--    katalog `synced_at` ise içerik hash'i değişince yazılır; ikisi de sessizliği ÖLÇMEZ.
--    Bu panelde gerçek bir kesinti tam da bu yüzden GÜNLERCE fark edilmemişti.
-- 3) audit_log üç bileşik indeks — denetim izi ekranının süzgeçleri (actor / hedef / eylem).
--    Tabloda yalnız created_at indeksi vardı; append-only ve hızlı büyüyen bir tabloda bu
--    sorgular tam tablo taramasıydı. İkinci kolon DESC: sıralama her zaman created_at DESC ve
--    yön ayna değildir (0031 dersi) — tie-break ancak aynı yönde indeksten karşılanır.
ALTER TABLE "admin_users" ADD COLUMN IF NOT EXISTS "totp_secret_enc" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN IF NOT EXISTS "totp_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_actor_idx" ON "audit_log" USING btree ("actor","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_action_idx" ON "audit_log" USING btree ("action","created_at" DESC NULLS LAST);
