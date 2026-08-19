# `scripts/` — hangi betik NEREDE çalışır

Bu klasörde iki farklı tür betik yan yana durur ve **hangi makinede çalıştıkları** karıştırıldığında
gerçek arıza üretirler (yaşandı: prod checkout'unda sürüm artırmaya çalışmak repoyu origin'den
ayırır ve sonraki tüm `deploy.sh` koşumlarını `git pull --ff-only` adımında kilitler).

| Betik | Nerede koşar | Ne yapar |
|---|---|---|
| **Kapılar** (`check-*.js`) | Her yerde (`pnpm typecheck` + CI) | Aşağıdaki tabloya bakın |
| `deploy.sh` | **VPS / prod** | Paneli (API+Admin) dağıtır: ff-pull → build → up → **sağlık kapısı** → başarısızsa **otomatik geri alma** |
| `deploy-runner.sh` | **VPS host** (cron, dakikada bir) | Panelden gelen dağıtım/yayın/yedek isteğini alır ve `deploy.sh` / `publish-plugin.sh`'ı koşar (panel konteynerine Docker soketi VERİLMEZ) |
| `backup-runner.sh` | **VPS host** (cron) | `pg_dump` yedeği alır; dış kopya kancası (`BACKUP_OFFSITE_CMD`) varsa çağırır |
| `backup-drill.sh` | **VPS** (aylık) | Yedekten GERİ YÜKLEME tatbikatı — yedeğin gerçekten açıldığını kanıtlar |
| `publish-plugin.sh` | **VPS / prod** | HEAD'deki eklentiyi paketleyip panele yayınlar. **Sürüm ARTIRMAZ, commit atmaz** |
| `release-plugin.sh` | **Geliştirici makinesi** | Eklenti sürümünü artırır (3 yazım) + yayın commit'i + paketleyip yayınlar. `git push` YAPMAZ |
| `dev-stack.sh` | **VPS** | İzole dev/staging yığını (`-p lisansdev`) — prod'a DOKUNMAZ |
| `wp-dev.sh` | **Yerel** | WordPress + WooCommerce test sitesini tek komutla kurar (`pnpm wp:dev`) |
| `test-integration.sh` | **Her yerde** (yalnız `docker` ister) | Entegrasyon + yarış paketini izole PG17/Redis7 konteynerleriyle koşar (`pnpm test:iso`) |
| `smoke-routes.sh` | **Her yerde** | 37 admin rotasını gezer; HTTP koduna DEĞİL, gövdedeki `error.tsx` imzasına bakar |

> **Neden sürüm artırımı VPS'te yapılmaz:** prod checkout'unda `git config user.*` tanımlı değil,
> remote HTTPS ve kimlik bilgisi yok, ve en önemlisi yerel commit repoyu origin'den ayırıp panel
> dağıtımını kalıcı olarak kilitler. Prod checkout'u **salt-okunur ayna** gibi düşünülmelidir:
> yalnız ileri sarar. Tam süreç: [`docs/RUNBOOK-RELEASE.md`](../docs/RUNBOOK-RELEASE.md).

## Kapılar (`pnpm typecheck` zinciri + ayrı CI adımları)

Hepsi aynı desendedir: **ölçülmüş bir arızayı** tekrar etmesin diye vardır, hata mesajı ne
yapılacağını söyler, ve her biri **kontrol denemesiyle** (düzeltmeyi geri al, kırmızıyı GÖR)
doğrulanmıştır — az denetleyen bir kapı, kapı yokluğundan beterdir.

| Kapı | Yakaladığı arıza |
|---|---|
| `check-use-server.js` | `'use server'` dosyasından obje/değer export'u — `next build` temiz geçer, TIKLAMADA patlar (iki kez canlıda) |
| `check-nest-wiring.js` | Eksik DI/kuyruk kablolaması — API **hiç boot etmez** ve `tsc` görmez |
| `check-env-passthrough.js` | Kod bir env okuyor ama compose geçirmiyor / `.env.example` belgelemiyor → `.env`'e yazmak ETKİSİZ (iki kez) |
| `check-workflows.js` | Geçersiz iş akışı YAML — CI **19 gün boyunca hiç koşmadı** |
| `check-tx-pool.js` | Transaction gövdesinden kök havuz sorgusu → havuz tükenince **tam kesinti** (k6 ile iki kez ölçüldü) |
| `check-plugin-version.js` | Eklenti sürümünün üç yazımı (başlık · `WPTESLIMAT_VERSION` · `Stable tag`) ayrışması → yayın durur, sessiz kalsa sonsuz "güncelleme var" döngüsü |
| `check-docs.js` | Şartname ↔ kod sapması: tablo · kuyruk · rota (iki yönlü, hayalet ekran dahil) · rota sayısı iddiaları · API ucu · üretilmiş görsel kopyanın tazeliği |

`build-mimari-gorsel.js` bir kapı değil **üreteçtir**: `docs/mimari-gorsel.html`'i
`docs/MIMARI.md`den render eder (`pnpm docs:gorsel`); tazeliğini `check-docs` denetler.
