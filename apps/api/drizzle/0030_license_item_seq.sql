-- UYARI (gelecekteki büyük tablolar için): `ADD COLUMN ... bigserial NOT NULL` DEFAULT'u
-- volatile (nextval) olduğu için PG11+ metadata-only hızlı yolunu KULLANAMAZ → TAM TABLO
-- YENİDEN YAZIMI + ACCESS EXCLUSIVE kilit (tüm index'ler de yeniden inşa edilir).
-- Migration api boot'unu bloklar (compose: migrate && main) ve deploy.sh sağlık için 60 sn
-- bekler → aşılırsa OTOMATİK ROLLBACK. Bu migration uygulandığında tablo KÜÇÜKTÜ (prod 3,
-- dev 22 satır → milisaniyeler); ÖLÇÜLDÜ. Tablo milyonlara çıktıktan sonra benzer bir kolon
-- eklenecekse rewrite'sız desen kullanılmalı: nullable bigint ekle → CREATE SEQUENCE →
-- parti parti backfill → SET DEFAULT nextval → NOT VALID CHECK + VALIDATE → SET NOT NULL.
--
-- GEÇMİŞ SATIRLAR: seq değerleri heap FİZİKSEL sırasıyla dolar. license_items satırları
-- atama/iade/kapasite yollarında UPDATE gördüğü için bu sıra gerçek ekleme sırasından
-- SAPABİLİR → eski bloklarda sıra garantisi YOKTUR, yalnız bu migration SONRASI girişlerde
-- kesindir. (Yapıştırma sırası daha önce hiçbir yere yazılmıyordu; geri kazanılamaz.)
DROP INDEX "license_items_created_idx";--> statement-breakpoint
ALTER TABLE "license_items" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "license_items_created_idx" ON "license_items" USING btree ("created_at" DESC NULLS LAST,"seq");