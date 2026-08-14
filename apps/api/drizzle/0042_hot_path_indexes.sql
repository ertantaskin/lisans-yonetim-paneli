-- 0042 — SICAK YOL İNDEKSLERİ (denetim/perf bulguları). Yalnız indeks; kolon/tablo değişmez.
--
-- IDEMPOTENT (IF NOT EXISTS / IF EXISTS): migration'lar API boot'unda otomatik koşar; kısmen
-- uygulanmış bir ortamda ikinci koşuş NO-OP olmalı, boot'u kırmamalı.
--
-- BÜYÜK TABLO REÇETESİ (bugün gerekmiyor): bu indeksler CREATE INDEX ile (CONCURRENTLY DEĞİL)
-- oluşturulur, yani tablo indeks kurulurken YAZMAYA kapalıdır. Uygulandığı anda prod/dev
-- tabloları küçüktü (ölçüldü). İleride license_items/orders milyonlara çıkarsa bu migration'ı
-- ELLE, transaction DIŞINDA `CREATE INDEX CONCURRENTLY` ile kurup journal'a işaretlemek gerekir
-- (drizzle migrator her dosyayı tek transaction'da koşar, CONCURRENTLY orada ÇALIŞMAZ).

-- [1] Atomik atamanın TAM karşılığı. Eski _fefo_idx yalnız (product_id, expires_at) taşıyordu;
--     created_at/seq indekste olmadığı için sıralama anahtarlarını okumak üzere her aday satır
--     için heap'e gidiliyor ve expires_at IS NULL çoğunlukta olduğu için LIMIT devreye girmeden
--     ürünün TÜM available satırları sıralanıyordu.
CREATE INDEX IF NOT EXISTS "license_items_alloc_idx" ON "license_items" USING btree ("product_id","expires_at","created_at","seq") WHERE "license_items"."status" = 'available';--> statement-breakpoint

-- [2] Kusurlu stok (/quarantine) sıralaması bir İFADE (coalesce) — hiçbir kolon indeksi
--     karşılamıyordu, kümülatif büyüyen küme her açılışta tam sıralanıyordu.
CREATE INDEX IF NOT EXISTS "license_items_dead_at_idx" ON "license_items" USING btree (coalesce("assigned_at", "created_at") DESC,"seq" DESC NULLS LAST) WHERE "license_items"."status" IN ('quarantined', 'voided');--> statement-breakpoint

-- [3] Tamamlama motorunun FIFO taraması (priority DESC, created_at) artık indeksten karşılanır.
CREATE INDEX IF NOT EXISTS "order_lines_pending_fifo_idx" ON "order_lines" USING btree ("product_id","priority" DESC NULLS LAST,"created_at") WHERE "order_lines"."status" IN ('pending', 'partial') AND "order_lines"."canceled" = false;--> statement-breakpoint

-- [4] "Bekleyen Teslimatlar" — orders.status üzerinde HİÇ indeks yoktu.
CREATE INDEX IF NOT EXISTS "orders_open_status_idx" ON "orders" USING btree ("status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "orders"."status" IN ('pending', 'partial', 'unmapped');--> statement-breakpoint

-- [5] Müşteri 360 lower(customer_email) sorgusu ham kolon indeksini KULLANAMIYORDU.
CREATE INDEX IF NOT EXISTS "replacement_requests_email_lower_idx" ON "replacement_requests" USING btree (lower("customer_email"));--> statement-breakpoint

-- [6] Sipariş detayı her açılışta indekssiz FK (order_id) üzerinden tam tarama yapıyordu.
CREATE INDEX IF NOT EXISTS "replacement_requests_order_idx" ON "replacement_requests" USING btree ("order_id","created_at" DESC NULLS LAST);--> statement-breakpoint

-- [7] Ürün detayı "Eşlemeler" + ürün silmedeki RESTRICT doğrulaması (indekssiz FK).
CREATE INDEX IF NOT EXISTS "mappings_product_idx" ON "site_product_mappings" USING btree ("product_id");--> statement-breakpoint

-- [8] ARTIK GEREKSİZ İKİ İNDEKS — yenilerinin ÖN EKİ ve kısmi koşulu birebir aynı olduğu için
--     onların karşıladığı her planı yeni indeksler de karşılar. license_items her stok girişinde
--     ve her atamada, order_lines her siparişte yazıldığı için gereksiz indeks taşımak saf
--     yazma maliyetidir. (Bu iki DROP, yukarıdaki CREATE'lerden SONRA gelmeli — arada plan
--     kaybı olmasın.)
DROP INDEX IF EXISTS "license_items_fefo_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "order_lines_pending_product_idx";
