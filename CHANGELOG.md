# Değişiklik Günlüğü (Changelog)

Bu projenin tüm önemli değişiklikleri bu dosyada belgelenir.
Format: [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) · Sürümleme: [SemVer](https://semver.org/lang/tr/).

Bu dosya **sohbet hafızasından bağımsız, kalıcı** yayın geçmişidir — her sürümde ne
değiştiğini burada görürsün. Dağıtım kaydı (ne zaman/hangi git sha ile prod'a gitti):
[docs/DEPLOY-LOG.md](docs/DEPLOY-LOG.md). Yayın süreci: [docs/RUNBOOK-RELEASE.md](docs/RUNBOOK-RELEASE.md).

İki ayrı sürüm izi vardır:
- **Panel** (API + Admin) — bu dosyadaki sürüm numarası + `git tag vX.Y.Z`.
- **WP eklentisi** — kendi sürümü (`apps/wp-plugin/wpteslimat/wpteslimat.php` `Version:`),
  müşteri sitelerine `plugin_releases` üzerinden dağıtılır (bkz. Sürümler / `/releases`).

## [Yayınlanmamış]

### WP eklentisi v0.5.0 (yayınlandı — panele publish, müşteri siteleri güncelleyebilir)
- **Lisanslar sipariş-kalemi bağlamında (per-line):** her ürünün anahtarları + Göster/Değiştir/
  Askıya al/+1 Bonus + değişim geçmişi artık o ürünün SİPARİŞ KALEMİ altında (uzun sağ metabox
  yerine) → çok ürünlü siparişte her ürün kendi bağlamında yönetilir.
- **Yenilenmiş kart arayüzü (UI/UX):** başlıkta özet sayaç ("N lisans · X aktif · Y askıda"),
  renkli durum rozetleri (Aktif/Askıda/İptal…), ikonlu + hiyerarşik butonlar (nötr Göster / mavi
  Değiştir / amber Askıya al / yeşil Geri aç), ürün-bazlı "Bonus Ekle" alt aksiyonu, katlanır
  değişim geçmişi; **5+ anahtarda kart kaydırılır** (max-height ~232px) → sipariş ekranı asla
  uzamaz. İptal/değiştirilen anahtarda aksiyon butonu görünmez (yanlış işlem imkânsız). Saf
  sunum katmanı — backend/API/kontrat değişmedi, migration yok.
- **+1 Bonus ürün-bazlı:** ayrı sentetik satır (`bonus:<item>:…`) → sonraki Woo senkronu/iadesi
  bonusu geri almaz (qty şişmez).
- **Kritik iade düzeltmesi:** kısmi iade sonrası re-sync artık iade edilen birimleri yeniden
  teslim ETMEZ (net adet gönderilir); `bundleQty>1` üründe iade doğru ölçeklenir (aşırı revoke giderildi).
- 16 WP denetim düzeltmesi (boş-secret webhook reddi, misafir Sorun Bildir, katalog önbelleği,
  100+ toplu-güncelleme parçalama vb.).

### Düzeltildi — teslimat-hazırlık denetimi (5-lens workflow, 16 doğrulanmış bulgu)
- **Dağıtım [yüksek]:** `deploy.sh` rollback artık dala BAĞLI kalır (`git reset --hard`; eskiden
  `git checkout <sha>` → detached HEAD sonraki TÜM deploy'ları kilitliyordu); build/up hatası da
  (yalnız sağlık değil) rollback tetikler; admin hedefi deploy'da runtime probu ile doğrulanır;
  renk kodları yalnız TTY'de (runner logunu/paneli kirletmez).
- **Dağıtım [yüksek]:** `deploy-runner.sh` deploy çıktısını göndermeden jq içinde 20000 karaktere
  kısaltır (>200KB build logu artık `finish`'i 400'lemez → başarılı deploy 'stuck/failed' kalmaz);
  controller Zod cap'leri servis `.slice` ile hizalı; `deployments.request()` advisory-lock ile
  serileştirildi (çift-tık iki 'pending' üretmez).
- **Sürüm raporlama:** `apps/api` + `apps/admin` sürümü 1.0.0'a çekildi → /health + /deployments +
  /settings artık doğru sürümü gösterir (eskiden kalıcı 0.0.0).
- **Eklenti bağlantısı:** "Panele Bağlan" kod akışı artık siteye geri-kanal `webhookUrl`'ini (host
  doğrulamalı) yazar → bağlan-kodla kurulan sitede order.fulfilled/partial webhook'ları GERÇEKTEN
  gönderilir (eskiden NULL kalıp sessizce atlanıyordu); bağlantı testi yanlış-yeşil yerine 'beklemede'.
- **WP performans:** sipariş push/revoke/resync artık Action Scheduler ile ARKA PLANDA çalışır
  (checkout/admin isteği 15sn bloklanmaz; AS yoksa senkron fallback, idempotency+klon guard'ı korunur);
  render okuma yolları (my-account + metabox) 5sn timeout ile asılmaz.
- **WP doğruluk:** `is_clone()` şema-bağımsız (HTTP→HTTPS geçişi artık klon sanılmaz); misafir
  'Sorun Bildir' `order_key` ile yetkilendirilir (eskiden guest checkout'ta hep 403); güncelleyici
  changelog'u `sections`'tan okunur; 'unmapped' durumu için Türkçe etiketler.
- **.env.example:** ölü `NEXT_PUBLIC_API_URL` yerine gerçek `API_URL` belgelenir; `PUBLIC_API_URL` eklendi.

### Eklendi
- **Yayın yönetim sistemi:** CHANGELOG + semantik sürüm + `docs/DEPLOY-LOG.md` (dağıtım
  geçmişi) + `docs/RUNBOOK-RELEASE.md` (adım adım yayın rehberi).
- `scripts/deploy.sh` — panel → prod tek-komut dağıtım (git pull + build + migration +
  health + hata olursa geri alma + deploy-log kaydı).
- `scripts/release-plugin.sh` — WP eklentisi tek-komut yayın (sürüm artır + zip + panele
  yayınla + changelog).
- Admin **/releases (Sürümler)** — eklenti sürüm geçmişi + yeni sürüm yayınlama arayüzü
  (backend `GET/POST /v1/admin/updates/plugin` zaten vardı).
- **Panelden dağıtım yönetimi — /deployments (Dağıtımlar):** canlı sürüm + sağlık +
  dağıtım geçmişi (salt-okunur) ve owner'a özel "Prod'a dağıt" tetikleyici. `deployments`
  tablosu (migration 0021) + API (`POST/GET /v1/admin/deployments`, runner için
  `claim`/`finish`) + host runner `scripts/deploy-runner.sh` (cron → `deploy.sh`). Panel
  konteynerine Docker soketi VERİLMEZ — istek/runner ayrımı güvenlik gereği. Aynı anda tek
  aktif dağıtım; 30dk'dan eski takılı "running" otomatik "failed" (self-heal).
- **Yerel geliştirme ortamı:** `scripts/wp-dev.sh` (tek-komut WordPress+WooCommerce dev
  sitesi, panele otomatik bağlanır), iyileştirilmiş `docker-compose.wp.yml`,
  [docs/GELISTIRME.md](docs/GELISTIRME.md), kök `package.json` kısayolları (`wp:dev`, `stack:up` …).

### Değişti
- **Tam yeniden adlandırma — `jetlisans` kaldırıldı (iç tanımlayıcılar dahil).** İki sistematik ad:
  panel paketleri `@jetlisans/*` → **`@lisans/*`** (kök paket `lisans-panel`); WP eklentisi tüm
  tanımlayıcılar → **`wpteslimat`** (klasör/ana dosya/sınıf/fonksiyon/sabit/option/cron/meta,
  text-domain, REST namespace, updater slug, DB tablosu). DB kimlik şablonları → `lisanspanel`.
- **Geriye dönük uyum (mevcut kurulumlar kesintisiz):** eklenti eski `JETLISANS_*` wp-config
  sabitlerini yeni ada köprüler; tek-seferlik göç eski kuyruk tablosunu + connect-option'larını
  taşır; webhook alıcı eski REST rotasını da dinler.

## [1.0.0] - 2026-07-27

İlk resmî sürümlenmiş yayın. Sistem üretimde, uçtan uca doğrulanmış ve VPS'te canlı
(bu tarihe kadarki tüm geliştirme; ayrıntı: proje geçmişi ve `CLAUDE.md`).

### Öne çıkanlar
- **Çekirdek:** WooCommerce → panel sipariş push (HMAC), atomik key atama (`FOR UPDATE
  SKIP LOCKED`, çifte satış imkânsız), kısmi teslimat, tamamlama motoru, geri-kanal webhook.
- **Ürün modeli:** key / hesap / süreli hesap / kod / stoksuz; tek & çoklu kullanım (MAK).
- **Güvenlik:** AES-256-GCM envelope şifreleme (AAD), HMAC imza + nonce/rotasyon, çoklu-admin
  auth (env-gated), KVKK anonimleştirme, güvenlik olayları/anomali tespiti.
- **Operasyon:** tedarik zinciri (tedarikçi/PO/parti/düzeltme), değişim & garanti kuyruğu,
  müşteri 360 + site→müşteri hiyerarşisi, raporlar, şablonlar, bildirimler, inceleme kuyruğu.
- **Marka:** panel "Lisans Paneli"; WP eklentisi görünen adı "WP Teslimat Eklentisi"
  (bu sürümde yalnız görünen adlar; iç tanımlayıcılar bir sonraki sürümde tamamen
  sadeleştirildi — bkz. [Yayınlanmamış] › Değişti).

### Son düzeltmeler (1.0.0 öncesi denetimler)
- 5-lens sistem denetimi → 9 bulgu: `completeLine` webhook kaybı (mail/webhook ayrı
  try/catch), WP klon guard tabanı (const/manuel kurulumda), satış-hızı/stok-önizleme
  status filtreleri, security-scan perf, Sentry health-probe istisnası.
- Round-3 denetim → 19 bulgu (queue/cron, güvenlik/crypto, mail/notif, tedarik/rapor, UX).
- Müşteri bölümü site→müşteri hiyerarşisine taşındı.

[Yayınlanmamış]: https://github.com/ertantaskin/lisans-yonetim-paneli/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ertantaskin/lisans-yonetim-paneli/releases/tag/v1.0.0
