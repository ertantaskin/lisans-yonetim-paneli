-- PERF (denetim): `batches` tablosunda eksik iki indeks. FK KISITI İNDEKS YARATMAZ —
-- Postgres yalnız REFERANS EDİLEN tarafta unique arar, referans EDEN kolon indekssiz kalır.
--   · batches_supplier_idx : tedarikçi karnesi (parti listesi + agregası) ve maliyet raporları
--     (CostsService.bySupplier/wastage) `supplier_id` ile süzüyor → tam tablo taramasıydı.
--   · batches_received_idx : parti listesinin sıralaması (`received_at DESC, id DESC`;
--     supply-ops.listBatches penceresi) indekssizdi. Yön DESC olmalı — planlayıcı ters tarayabilse
--     de `id DESC` tie-break'i ancak aynı yönde karşılanır (0031 dersi: yönler ayna değildir).
--
-- ADDITIVE + IDEMPOTENT (`IF NOT EXISTS`): migration boot'ta koşar; var olan bir indekste
-- çıplak CREATE INDEX hata verir ve API HİÇ AÇILMAZ. Her stok girişi bir parti ürettiği için
-- tablo küçük→orta boyuttadır; CREATE INDEX'in kısa ACCESS EXCLUSIVE kilidi kabul edilir
-- (migrator tek transaction'da koştuğu için CONCURRENTLY KULLANILAMAZ).
CREATE INDEX IF NOT EXISTS "batches_supplier_idx" ON "batches" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "batches_received_idx" ON "batches" USING btree ("received_at" DESC NULLS LAST,"id" DESC NULLS LAST);
