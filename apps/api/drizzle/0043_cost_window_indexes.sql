-- 0043 — MALİYET RAPORU DÖNEM PENCERESİ İNDEKSLERİ. Yalnız indeks; kolon/tablo değişmez.
--
-- /reports/costs artık `?from&to` (varsayılan son 12 ay) ile pencereleniyor; pencereyi
-- karşılayan indeksler yoktu → dönem filtresi eklendiğinde bile tarama tam tablo kalırdı.
--
-- IDEMPOTENT (IF NOT EXISTS): migration'lar API boot'unda otomatik koşar.
-- Büyük tablo reçetesi için bkz. 0042 başlığı (CONCURRENTLY elle, transaction dışında).

-- [1] "Teslim Edilen Mal Maliyeti": WHERE delivered_at >= …
--     delivered_at üzerinde indeks YOKTU (SLA servisi bu yüzden created_at kullanıyor).
--     Kısmi: teslim edilmemiş atamalar bu sorguya hiç girmez.
CREATE INDEX IF NOT EXISTS "assignments_delivered_at_idx" ON "assignments" USING btree ("delivered_at") WHERE "assignments"."delivered_at" IS NOT NULL;--> statement-breakpoint

-- [2] Tedarikçi/ürün kırılımı: harcama TESLİMDE gerçekleşir → coalesce(received_at, created_at).
--     Bu bir İFADE — mevcut purchase_orders_created_idx onu karşılamaz.
CREATE INDEX IF NOT EXISTS "purchase_orders_spent_at_idx" ON "purchase_orders" USING btree (coalesce("received_at", "created_at"));--> statement-breakpoint

-- [3] "Zayi" bloğu: WHERE created_at >= … AND action IN (…). Kısmi yüklem SERVİSTEKİYLE
--     birebir aynıdır ('correct' = sayım düzeltmesi, zayi değil → indeks dışında).
CREATE INDEX IF NOT EXISTS "stock_adjustments_created_idx" ON "stock_adjustments" USING btree ("created_at") WHERE "stock_adjustments"."action" IN ('void', 'damage', 'recall');
