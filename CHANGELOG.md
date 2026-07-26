# Değişiklik Günlüğü (Changelog)

Bu projenin tüm önemli değişiklikleri bu dosyada belgelenir.
Format: [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) · Sürümleme: [SemVer](https://semver.org/lang/tr/).

Bu dosya **sohbet hafızasından bağımsız, kalıcı** yayın geçmişidir — her sürümde ne
değiştiğini burada görürsün. Dağıtım kaydı (ne zaman/hangi git sha ile prod'a gitti):
[docs/DEPLOY-LOG.md](docs/DEPLOY-LOG.md). Yayın süreci: [docs/RUNBOOK-RELEASE.md](docs/RUNBOOK-RELEASE.md).

İki ayrı sürüm izi vardır:
- **Panel** (API + Admin) — bu dosyadaki sürüm numarası + `git tag vX.Y.Z`.
- **WP eklentisi** — kendi sürümü (`apps/wp-plugin/jetlisans/jetlisans.php` `Version:`),
  müşteri sitelerine `plugin_releases` üzerinden dağıtılır (bkz. Sürümler / `/releases`).

## [Yayınlanmamış]

### Eklendi
- **Yayın yönetim sistemi:** CHANGELOG + semantik sürüm + `docs/DEPLOY-LOG.md` (dağıtım
  geçmişi) + `docs/RUNBOOK-RELEASE.md` (adım adım yayın rehberi).
- `scripts/deploy.sh` — panel → prod tek-komut dağıtım (git pull + build + migration +
  health + hata olursa geri alma + deploy-log kaydı).
- `scripts/release-plugin.sh` — WP eklentisi tek-komut yayın (sürüm artır + zip + panele
  yayınla + changelog).
- Admin **/releases (Sürümler)** — eklenti sürüm geçmişi + yeni sürüm yayınlama arayüzü
  (backend `GET/POST /v1/admin/updates/plugin` zaten vardı).
- **Yerel geliştirme ortamı:** `scripts/wp-dev.sh` (tek-komut WordPress+WooCommerce dev
  sitesi, panele otomatik bağlanır), iyileştirilmiş `docker-compose.wp.yml`,
  [docs/GELISTIRME.md](docs/GELISTIRME.md), kök `package.json` kısayolları (`wp:dev`, `stack:up` …).

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
  (iç anahtarlar `jetlisans` — geriye uyum).

### Son düzeltmeler (1.0.0 öncesi denetimler)
- 5-lens sistem denetimi → 9 bulgu: `completeLine` webhook kaybı (mail/webhook ayrı
  try/catch), WP klon guard tabanı (const/manuel kurulumda), satış-hızı/stok-önizleme
  status filtreleri, security-scan perf, Sentry health-probe istisnası.
- Round-3 denetim → 19 bulgu (queue/cron, güvenlik/crypto, mail/notif, tedarik/rapor, UX).
- Müşteri bölümü site→müşteri hiyerarşisine taşındı.

[Yayınlanmamış]: https://github.com/ertantaskin/lisans-yonetim-paneli/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ertantaskin/lisans-yonetim-paneli/releases/tag/v1.0.0
