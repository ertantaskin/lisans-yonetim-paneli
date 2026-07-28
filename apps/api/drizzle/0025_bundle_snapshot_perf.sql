-- 0025 — bundleQty snapshot + iş-istasyonu sıcak-yol index'leri (ADDITIVE; veri kaybı yok).
--
-- (A) order_lines.bundle_qty — TESLİMAT ANINDAKİ paket adedi anlık görüntüsü.
--     Sorun: reconcileOrder/syncRefunds satırın PANEL birimini her seferinde CANLI eşlemeden
--     (`resolveMapping`) yeniden türetiyordu. Eşleme sonradan pasifleştirilir/silinirse
--     bundleQty sessizce 1'e düşüyor, satır "aşırı teslim" sanılıp müşterinin CANLI anahtarları
--     iade edilmediği hâlde geri alınıyordu. Ölçek artık satıra yazılır ve oradan okunur →
--     eşleme değişse de geçmiş siparişin birim uzayı sabit kalır.
--     NULL = bilinmiyor: (a) eşlemesiz satır (qty MAĞAZA birimindedir), (b) 0025 öncesi eski satır
--     (geriye dönük: canlı eşleme varsa ondan okunur, yoksa qty'ye DOKUNULMAZ).
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS bundle_qty INTEGER;

-- (B) Lisans envanteri + canlı akış sıcak yolları. Panel gün boyu açık kalıyor ve canlı uç
--     sekme başına 15 sn'de bir çağrılıyor → bu sorgular seq-scan'e düşmemeli.
CREATE INDEX IF NOT EXISTS license_items_created_idx
  ON license_items (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS license_items_status_created_idx
  ON license_items (status, created_at DESC);
CREATE INDEX IF NOT EXISTS license_items_assigned_idx
  ON license_items (assigned_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS license_items_batch_idx
  ON license_items (batch_id);
CREATE INDEX IF NOT EXISTS replacement_requests_created_idx
  ON replacement_requests (created_at DESC, id DESC);
