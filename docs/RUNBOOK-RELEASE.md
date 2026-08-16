# Yayın Runbook'u (Release Runbook)

Bu belge **yayın sürecinin tek doğruluk kaynağıdır** — kim (insan veya AI oturumu)
dağıtım yapacaksa bu adımları izler. Amaç: her seferinde aynı, güvenli, izlenebilir süreç.

## Altın kural

> **Kod git'te yaşar. Ortamlar sadece git checkout + docker build'dir.**
> Prod'a asla elle dokunma; değişikliği **git üzerinden terfi ettir**. Dev'in verisi
> (test sipariş/site/stok) prod'a GİTMEZ — ayrı DB'de kalır. Sadece kod taşınır.

## Ortamlar

| Ortam | Nerede | Amaç | Veri |
|---|---|---|---|
| **Yerel dev** | Windows / `docker compose` | Hızlı geliştirme + test | Yerel DB (atılabilir) |
| **İzole dev/staging** | VPS, `-p lisansdev` projesi | Prod'a gitmeden gerçek ortam testi | Ayrı DB/ağ (prod'a dokunmaz) |
| **Prod** | VPS, `/opt/lisans-yonetim-paneli` | Canlı — müşteriye açık | Prod DB |

İki dağıtım **hedefi** ayrıdır:
1. **Panel** (API + Admin) → bizim sunucumuz → `scripts/deploy.sh`.
2. **WP eklentisi** → müşterinin WordPress siteleri → `scripts/release-plugin.sh`
   (geliştirici makinesi) veya panelden **"Kaynaktan yayınla"** → `scripts/publish-plugin.sh` (VPS).

---

## A. Panel sürümü çıkarma (kod → prod)

1. **Geliştir** (yerel veya izole dev). Değişikliği test et:
   ```bash
   pnpm typecheck && pnpm build
   pnpm --filter @lisans/api test        # birim
   # davranış değiştiyse VPS izole test DB'sinde entegrasyon+yarış (bkz. RUNBOOK-DR / CLAUDE.md)
   ```
2. **CHANGELOG.md** → `[Yayınlanmamış]` altına ne değiştiğini yaz.
3. **Sürüm** (kullanıcı-görünür değişiklik veya birikmiş iş varsa): version'ı SemVer'e göre artır
   (yama=fix, minör=özellik, majör=kırıcı). `[Yayınlanmamış]` → `[X.Y.Z] - TARİH`.
   **ÜÇ package.json birlikte:** kök + `apps/api/package.json` + `apps/admin/package.json` — API
   `/health`+`/deployments` sürümü `apps/api`'den, admin `/settings` sürümü `apps/admin`'den okur;
   yalnız kökü artırırsan panel eski sürümü gösterir.
4. **Commit + push:**
   ```bash
   git add -A && git commit -m "..."   # sonunda Co-Authored-By trailer
   git push origin main
   git tag vX.Y.Z && git push origin vX.Y.Z    # sürüm çıktıysa
   ```
5. **Dağıt** (prod'da çalışır):
   ```bash
   ssh -i <key> root@167.233.108.12 'cd /opt/lisans-yonetim-paneli && ./scripts/deploy.sh api admin'
   ```
   `deploy.sh` şunları yapar: temiz-ağaç kontrolü → `git pull --ff-only` → **argümanla verilen
   servisleri** (varsayılan `api admin`; değişiklik tespiti YOK, verilen ne ise o) build →
   `up -d` → migration (api açılışında otomatik: `migrate.js && main.js`) → sağlık kapısı
   (**API `/v1/health` + admin dağıtıldıysa admin runtime probu**) → **başarısızsa otomatik geri
   alma** (dala BAĞLI kalarak `git reset --hard <önceki-sha>` + rebuild) → disk temizliği
   (dangling imaj + eski build cache) → sunucu-yerel `.deploy-history.log`'a ham denetim satırı.

   > **`docs/DEPLOY-LOG.md` OTOMATİK GÜNCELLENMEZ.** Betiğin yazdığı dosya `.deploy-history.log`'tur
   > ve `.gitignore`'dadır (sunucu-yerel, ham). Görünür geçmiş satırını **siz** eklersiniz;
   > `deploy.sh` bitişte yalnız bunu hatırlatan bir satır basar.
6. **Doğrula:** `curl https://api.167-233-108-12.sslip.io/v1/health` → `{"status":"ok"}`.

### Geri alma (rollback)
`deploy.sh` build/up/sağlık adımlarından biri başarısızsa **otomatik** geri alır: dala BAĞLI
kalarak `git reset --hard <önceki-sha>` + rebuild (bilerek `git checkout` DEĞİL — detached HEAD
sonraki tüm dağıtımları `git pull --ff-only` adımında kilitlerdi).

> **Elle geri alırken `git checkout <sha>` KULLANMAYIN.** Bu, geri almayı iptal eder: bir
> sonraki `deploy.sh` detached HEAD'i görüp `main` dalına döner (self-heal) ve ff-pull ile
> **yine en yeni kodu** dağıtır. Doğru iki yol:

```bash
# 1) KALICI (önerilen) — kötü commit'i geri al, normal akışla dağıt:
#    geliştirici makinesinde:
git revert <kötü-sha> && git push origin main
#    sonra VPS'te:
ssh ... 'cd /opt/lisans-yonetim-paneli && ./scripts/deploy.sh api admin'

# 2) ACİL/GEÇİCİ (VPS'te, dala bağlı kalır):
ssh ... 'cd /opt/lisans-yonetim-paneli && git reset --hard <önceki-sha> \
  && docker compose build api admin && docker compose up -d api admin'
```

(2) geçicidir: bir sonraki `deploy.sh` koşumu ff-pull ile yine ileri sarar → kalıcı çözüm için
(1) şarttır.
Migration geri alma: migration'lar ileri-uyumlu additive'dir; şema geri almak GEREKMEZ
(eski kod yeni şemayla çalışır). Gerekirse DB yedeğinden dön (bkz. RUNBOOK-DR).

### A2. Panelden dağıtım (SSH'siz — runner ile)
Adım 5'in SSH gerektirmeyen alternatifi: `git push` sonrası panelde **Dağıtımlar
(/deployments)** → owner "Prod'a dağıt" (API / Admin / ikisi). Panel yalnız bir **istek**
kaydeder; VPS host'undaki cron runner bunu görüp `deploy.sh`'ı çalıştırır ve sonucu (başarılı/
başarısız + SHA + log) panele yazar. **Panel konteynerine Docker soketi VERİLMEZ** — güvenlik
gereği istek (panel) ile çalıştırma (host) ayrıdır. Sayfada canlı sürüm + sağlık + geçmiş görünür.

**Runner kurulumu (VPS'te, bir kez):**
```bash
apt-get install -y jq                      # jq ZORUNLU (betik yokluğunu açıkça bildirir)
# Ayrıca şunlar kurulu olmalı: curl · git · docker (deploy.sh için) · base64 (publish-plugin.sh)
# · flock = util-linux (tek-örnek kilidi) · sed. Eksiklerinde arıza YANLIŞ teşhis edilir
# (ör. curl yoksa "claim başarısız / API kapalı" gibi görünür).
crontab -e
# şu satırı ekle (dakikada bir bekleyen isteği kontrol eder):
* * * * * /opt/lisans-yonetim-paneli/scripts/deploy-runner.sh >> /var/log/deploy-runner.log 2>&1
```

> **Cron satırına `flock` EKLEME.** Runner tek-örnek kilidini kendi içinde alır
> (`/tmp/wpteslimat-deploy-runner.self.lock`). Dış `flock` sarmalayıcısı eklersen ikinci bir
> kilit katmanı oluşur; eskiden bu iki katman AYNI dosyada olduğu için runner kendi kendini
> kilitliyor ve dağıtım isteği hiç koşmadan 'pending'de kalıyordu. Eski satırı kullanan bir
> kurulum varsa yukarıdakiyle **değiştir** (kilit dosyaları artık ayrı olduğundan eski satır
> da kilitlenmez, ama tek doğru kurulum budur).

Runner `ADMIN_TOKEN`'ı repo kökündeki `.env`'den okur; API'ye `X-Admin-Token` ile bağlanır.
Aynı anda yalnız bir aktif iş olur — **dağıtım ve yedek AYNI kuyruğu paylaşır** (bkz. §A2 ve
`docs/RUNBOOK-DR.md §4.3`). Runner çökerse "running" kaydı **hedefe göre** otomatik "failed"
olur ve kilit açılır:

| Hedef | Zombi eşiği |
|---|---|
| `api` · `admin` · `api admin` · `plugin` | 30 dk |
| `backup` | 120 dk |
| `backup-drill` | 240 dk (RTO ≤ 2sa hedefi — süren meşru bir tatbikatı erken öldürmemek için) |

Hiç claim edilmemiş **`pending`** istek ise hedeften bağımsız **30 dk** sonra kapatılır (bu
"runner çalışmıyor" demektir — cron'u ve `/var/log/deploy-runner.log`'u kontrol et).

İlk kez bu özelliği yayına almak için A adımını (SSH+deploy.sh) bir kez kullan; sonraki
dağıtımlar panelden tetiklenebilir.

Runner **iki hedef sınıfına** dallanır (claim yanıtındaki `target`):

| `target` | Çalıştırdığı betik | Ne yapar |
|---|---|---|
| `api`, `admin`, `api admin` | `scripts/deploy.sh <target>` | Paneli prod'a dağıtır (rollback'li) |
| `plugin` | `scripts/publish-plugin.sh "<note>"` | WP eklentisini **HEAD'den** paketleyip panele yayınlar |

**İKİNCİ RUNNER — yedek (`scripts/backup-runner.sh`).** Aynı kuyruğu bir de yedek runner'ı
yoklar; `backup` / `backup-drill` hedeflerini alıp `scripts/backup-drill.sh`'ı çalıştırır.
Kurulumu (cron satırları, offsite kancası, rotasyon) **`docs/RUNBOOK-DR.md` §4.3-4.4**'tedir —
burada tekrarlanmaz, tek kaynak orasıdır.

> **Neden claim'de `targets` filtresi var:** iki runner aynı kuyruğu yokluyor. Filtre olmasaydı
> yedek runner'ı bir `api admin` isteğini kapar (ya da tersi) ve **claim geri alınamadığı için**
> istek "çalıştı ama dağıtım olmadı" diye kaybolurdu. Her runner claim gövdesinde kendi hedef
> listesini gönderir; alan API'de **opsiyoneldir** (gönderilmezse tüm hedefler) → eski runner
> sürümü kırılmaz, ama **iki runner birlikte kullanılıyorsa ikisi de güncel olmalıdır.**
>
> **Tek aktif iş kuralı ORTAKTIR:** yedek alınırken dağıtım (ve tersi) 409 yer. Bu bilinçlidir —
> `deploy.sh` servisleri yeniden başlatırsa süren `pg_dump` yarıda kalır. Uzun süren bir tatbikat
> dağıtımı geciktirebilir; acele bir dağıtım için tatbikatın bitmesini bekle (ya da SSH+`deploy.sh`).

`plugin` hedefinde istekteki **`note`** alanı changelog metni olarak betiğe geçer (boşsa
`"Sürüm <VER>"` kullanılır). Her iki hedefte de `git rev-parse --short HEAD` sonucu kayda yazılır →
eklenti yayınında "zip hangi commit'ten paketlendi" izlenebilir.

---

## B. WP eklentisi sürümü çıkarma (kod → müşteri siteleri)

Eklenti müşterinin sitesinde çalışır; güncelleme **panel üzerinden** dağıtılır (eklenti
kendi güncelleyicisiyle `/v1/updates/plugin/info`'yu yoklar).

**Sürüm artırma ve yayınlama İKİ AYRI iştir** — hangi makinede olduklarına dikkat:

| Betik | Nerede çalışır | Ne yapar | Ne YAPMAZ |
|---|---|---|---|
| `scripts/release-plugin.sh <sürüm>` | **Geliştirici makinesi** | Sürümü `wpteslimat.php` + `readme.txt`'de günceller (sed) → yayın commit'i atar → HEAD'den zip paketler → panele publish eder | `git push` yapmaz (sen yaparsın) |
| `scripts/publish-plugin.sh ["changelog"]` | **VPS / prod** (panelden tetiklenir) | `git pull --ff-only` → HEAD'den zip paketler → panele publish eder | **Sürüm artırmaz, commit atmaz, push gerektirmez** |

1. **Geliştir + test** — yerel/izole WP dev sitesinde (`scripts/wp-dev.sh`; plugin bind-mount
   → anında yansır). Klon guard, sipariş push, teslimat, webhook akışını dene.
2. **Yayınla** — iki yoldan biri:

   **B1) Geliştirici makinesinden (tek adım):**
   ```bash
   ./scripts/release-plugin.sh <yeni-sürüm>     # ör. 0.2.0
   git push origin main                         # yayın commit'ini uzağa gönder
   ```
   Script: `wpteslimat.php` + `readme.txt` sürümünü günceller → yayın commit'i atar → temiz
   `.zip` paketler → panele publish (`POST /v1/admin/updates/plugin`, ADMIN_TOKEN).

   **B2) Panelden ("Kaynaktan yayınla" — SSH'siz, zip yüklemesiz):**
   ```bash
   # geliştirici makinesinde YALNIZ sürümü artır + commit + PUSH (yayınlama panelde yapılacak):
   #   apps/wp-plugin/wpteslimat/wpteslimat.php → ' * Version:' + WPTESLIMAT_VERSION
   #   apps/wp-plugin/wpteslimat/readme.txt     → 'Stable tag:'
   git commit apps/wp-plugin/wpteslimat/wpteslimat.php apps/wp-plugin/wpteslimat/readme.txt \
     -m "release(plugin): vX.Y.Z"
   git push origin main
   ```
   (Panele erişimin varsa `release-plugin.sh` de aynı sürüm satırlarını günceller — ama o zaten
   yayınlar; B2'yi ayrıca çalıştırmak aynı sürümü üzerine yazar, zararsızdır.)

   Sonra panelde **Sürümler (/releases)** → **"Kaynaktan yayınla"** (changelog metni girilebilir).
   **Owner-only:** her iki yayınlama yolu da yalnız `owner` rolündeki yöneticiye görünür
   (birincil kapı Next `isOwner()`, API'de `OwnerGuard` savunma derinliği). Owner değilseniz
   düğme yerine açıklama görürsünüz.
   Panel bir dağıtım isteği kaydeder (`target=plugin`, `note=changelog`); VPS host'undaki cron
   runner (`deploy-runner.sh`) bunu alır ve `publish-plugin.sh`'ı çalıştırır:
   `git pull --ff-only` → eklenti dizini temiz mi → sürümü **HEAD'den** oku (başlık +
   `WPTESLIMAT_VERSION` tutarlı ve SemVer olmalı) → `git archive` ile zip → panele publish.
   Sonuç (başarılı/başarısız + SHA + tam log) **/deployments** ekranında görünür.

   **Alternatif (UI, elle zip):** panelde **Sürümler (/releases)** → "Yeni sürüm yayınla" (zip yükle) —
   bu da **owner-only**'dir (kurtarma yolu; normalde "Kaynaktan yayınla" tercih edilir, çünkü
   "yayınlanan zip = HEAD" invaryantını yalnız o korur).
3. **Doğrula:** panelde **/releases** listesinde yeni sürüm görünür; müşteri sitesi
   WP yönetici → Güncellemeler'de eklentiyi güncelleyebilir.

> SemVer: yama = hata düzeltme; minör = yeni özellik; majör = kırıcı/uyumsuz değişiklik.

> Aynı sürüm numarası yeniden yayınlanırsa panel kaydı **üzerine yazar** (zip + changelog
> güncellenir, `created_at` tazelenir). Yani başarısız bir yayını tekrar tetiklemek güvenlidir.

### B3. Neden VPS'te sürüm artırılmıyor / commit-push yapılmıyor?

`release-plugin.sh` VPS'te **sürüm ARTIRAMAZ** (yalnızca sürüm dosyaları HEAD ile zaten
aynıysa, yani "aynı sürümü yeniden yayınla" durumunda commit adımını atlayıp devam eder).
Bu bilinçli bir sınırdır; VPS'in doğru aracı `publish-plugin.sh`'tır:

* Prod checkout'unda (`/opt/lisans-yonetim-paneli`) `git config user.email` ve `user.name`
  **tanımlı değil** → `git commit` hata verir.
* Remote **HTTPS GitHub** ve kayıtlı kimlik bilgisi yok → `git push` `could not read Username`
  ile düşer. Yani commit atılsa bile uzağa gidemez.
* En önemlisi: prod checkout'unda **yerel commit üretmek repoyu origin'den AYIRIR** ve bir
  sonraki `deploy.sh`'ın `git pull --ff-only` adımını **kalıcı olarak kırar** → panel dağıtımı
  kilitlenir. (Prod checkout'u "salt-okunur ayna" gibi düşünülmeli: yalnız ileri sarar.)

Bu yüzden iş ikiye bölündü: **sürüm artırımı geliştirici makinesinde** (commit + push),
**yayınlama VPS'te** (yalnız paketle + yükle). `publish-plugin.sh` sürüm dosyalarına hiç
dokunmaz; HEAD'de hangi sürüm yazıyorsa onu yayınlar ve HEAD'deki başlık ile
`WPTESLIMAT_VERSION` sabiti uyuşmuyorsa (ya da SemVer değilse) **yayını durdurur**.

`publish-plugin.sh` şu durumlarda da durur (hepsi anlamlı Türkçe hata + çıkış kodu 1; hata metni
runner tarafından **/deployments** kaydına yazılır):

* `jq` / `curl` yok, ya da `ADMIN_TOKEN` bulunamadı (ortam veya repo kökündeki `.env`),
* repo **detached HEAD**'de (başarısız bir panel dağıtımının geri alması yürürlükte → HEAD eski
  kodu gösterir; bilinçli olarak self-heal YAPILMAZ, önce `deploy.sh` ile panel düzeltilir),
* `git pull --ff-only` başarısız (ayrışma / ağ / çalışma ağacı çakışması),
* eklenti dizininde commit'lenmemiş veya izlenmeyen değişiklik var (zip HEAD'den paketlenir →
  aksi halde "yayınlandı" der ama siteler farklı kodu çeker: sessiz yanlış yayın),
* HEAD'deki `Version:` başlığı ile `WPTESLIMAT_VERSION` sabiti uyuşmuyor ya da SemVer değil,
* üretilen zip boş, JSON gövde kurulamadı, ya da panel 200/201 dışında yanıt verdi.

---

## C. İzole dev/staging (VPS'te)

Prod'a dokunmadan gerçek bir ortamda test için ayrı proje:
Tek giriş noktası `scripts/dev-stack.sh` — compose'u elle çağırma:
```bash
ssh ... '/opt/lisans-yonetim-paneli/scripts/dev-stack.sh up'          # panel yığını (build + sağlık beklemesi)
ssh ... '/opt/lisans-yonetim-paneli/scripts/dev-stack.sh wp'          # izole WordPress dev sitesi
ssh ... '/opt/lisans-yonetim-paneli/scripts/dev-stack.sh status'      # durum
ssh ... '/opt/lisans-yonetim-paneli/scripts/dev-stack.sh down'        # durdur
ssh ... '/opt/lisans-yonetim-paneli/scripts/dev-stack.sh subdomains'  # prod Caddy'yi dev ağına bağla
```

Betiğin sardığı komut (yalnız elle koşmak gerekirse):
```bash
cd /opt/lisans-dev && docker compose -p lisansdev --env-file .env.dev \
  -f docker-compose.yml -f docker-compose.dev.yml \
  up -d --build postgres redis mailpit api admin
```

> **İKİ AYRINTI KRİTİK** (eksikse komut ya işe yaramaz ya da PROD'u böler):
> `-f docker-compose.dev.yml` verilmezse dev portları (`127.0.0.1:3002/3006/8026`) **hiç
> yayınlanmaz**; servis listesi verilmezse **`caddy` de kalkar** ve 80/443'ü tutan **prod
> Caddy ile çakışır**.

Erişim: dev API `http://127.0.0.1:3002/v1/health`, dev admin `http://127.0.0.1:3006`
(SSH tüneli ile) ya da prod Caddy üzerinden dev alt-alan adları (`subdomains` alt komutu).
Detay: `docs/GELISTIRME.md`. İzole yığın kendi Postgres/Redis/DB'siyle çalışır → test
siparişleri prod DB'sine **asla** yazılmaz.

---

## Kontrol listesi (her yayında)

- [ ] typecheck + build temiz
- [ ] ilgili testler geçti (davranış değiştiyse entegrasyon/yarış)
- [ ] CHANGELOG güncellendi
- [ ] sürüm artırıldı + tag atıldı (sürüm çıktıysa)
- [ ] `deploy.sh` health 200 döndü
- [ ] DEPLOY-LOG.md satırı **elle** eklendi (deploy.sh otomatik YAZMAZ — yalnız hatırlatır; onun yazdığı dosya sunucu-yerel `.deploy-history.log`'tur)
- [ ] (eklentiyse) /releases'te yeni sürüm göründü
