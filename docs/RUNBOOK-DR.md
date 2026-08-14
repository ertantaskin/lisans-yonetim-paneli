# RUNBOOK — Felaket Kurtarma (DR) & Yedek Tatbikatı

> Lisans Yönetim Paneli Merkezi Lisans Paneli · MIMARI.md **§16** (Operasyon: test, sürüm, DR) + **§8** (Güvenlik).
> Bu belge operasyoneldir: VPS'te elle uygulanır. Otomatik doğrulama scripti: `scripts/backup-drill.sh`.
> **Yedek artık panelden tetiklenebilir ve son yedek/tatbikat panelde görünür** — bkz. §4.3.

---

## 1. Hedefler

| Metrik | Hedef (§16) | Anlamı |
|---|---|---|
| **RPO** (Recovery Point Objective) | **≤ 5 dakika** | Felakette kaybedilebilecek en fazla veri. Sürekli WAL arşivleme (PITR) ile sağlanır. |
| **RTO** (Recovery Time Objective) | **≤ 2 saat** | Sıfırdan hizmeti geri getirme süresi. Tatbikatta `backup-drill.sh` "Geri-yükleme (RTO)" satırıyla ölçülür. |
| **Tatbikat sıklığı** | **Aylık** | Her ay `backup-drill.sh` çalıştırılır, PASS doğrulanır, sonuç §6 tablosuna kaydedilir. |

**Neden ikisi de önemli:** Sadece gecelik `pg_dump` alırsak RPO = 24 saate kadar çıkar (bir günlük
sipariş/atama kaybı = çifte satış / müşteri mağduriyeti riski). §16 hedefi RPO≤5dk olduğundan
**sürekli WAL arşivleme** (aşağıda §2) şarttır; mantıksal dump yalnız tatbikat + ek güvence katmanıdır.

---

## 2. Mevcut durum & önerilen hedef mimari

### 2.1 Şu an (Faz 0/1 — tek VPS)
- PostgreSQL 17 verisi tek Docker volume'da: **`pgdata`** (`docker-compose.yml`).
- **Mantıksal yedek panelden tetiklenebilir + zamanlanabilir** (§4.3): `scripts/backup-runner.sh`
  cron ile koşar, sonuç **/deployments** ekranında görünür ("Son yedek / Son tatbikat").
- **Offsite yükleme kod tarafından YAPILMAZ** — kimlik bilgisi gerektirir. Betikte açık bir
  **kanca** (`BACKUP_OFFSITE_CMD`) vardır; operatör kendi aracını bağlar (§4.4). Kanca
  bağlanmadıysa yedek **yalnız bu host'ta** durur ve host kaybında işe yaramaz.
- **PITR (RPO≤5dk) hâlâ YOK**: mantıksal dump anlıktır. §2.2 kurulana kadar RPO = son yedek anı.

### 2.2 Hedef (MIMARI.md §1 tasarımı) — **öneri, kurulacak**
> §1: "Yedek: **pgBackRest** → offsite **S3** + sürekli **WAL** (PITR); master key AYRI saklanır."

1. **pgBackRest** kur (repo = offsite S3/B2/Wasabi bucket, `repo1-retention-full`, sıkıştırma+şifreleme).
2. PostgreSQL `archive_mode=on` + `archive_command = 'pgbackrest --stanza=lisanspanel archive-push %p'`
   → her WAL segmenti offsite'a itilir ⇒ **RPO ≤ 5 dk** (`archive_timeout=60s` ile en fazla ~1dk WAL gecikmesi).
3. Günlük `full`/`diff`, saatlik `incr` yedek (cron). Restore: `pgbackrest --stanza=lisanspanel restore`
   + `--type=time --target='...'` ile **noktaya-dönük (PITR)** kurtarma.
4. Offsite kopyanın **kendisi de** düzenli tatbikatla doğrulanır (bu runbook §6).

> Geçiş tamamlanana dek `backup-drill.sh` **birincil** yedek+doğrulama aracıdır. pgBackRest kurulunca
> bu script "mantıksal yedek + hızlı bütünlük tatbikatı" olarak ikinci katmanda kalır (ikisi çelişmez).

---

## 3. MASTER_KEY — DB yedeğinden AYRI (§8) · KRİTİK

**Değişmez kural (§8):** `license_items.payload_enc` alanı AES-256-GCM envelope ile şifrelidir.
Çözme anahtarı **`MASTER_KEY`** (`.env`), payload'ın kendisiyle **AYNI yerde tutulmaz**.

- **Neden:** Yedek (DB dump veya pgdata/WAL) tek başına ele geçse bile, `MASTER_KEY` içinde
  olmadığından payload'lar **çözülemez**. Anahtarı yedeğin yanına koymak = şifrelemeyi anlamsız
  kılmak = tek dosyada tüm lisansların sızması (güvenlik ihlali).
- **Kural:**
  - `MASTER_KEY` **DB yedeğine dahil edilmez.** (`backup-drill.sh` yalnız DB'yi dump eder; `.env`
    veya anahtar dosyalarına dokunmaz.)
  - `MASTER_KEY` ayrı bir secret store'da (parola yöneticisi / KMS / kapalı zarf) **çevrimdışı en az
    2 kopya** olarak saklanır (§8: "çevrimdışı 2 kopya").
  - Restore tatbikatında anahtarın gerçekten geri yüklenebilir olduğu da doğrulanır (anahtar kaybı =
    kalıcı veri kaybı; DB sağlam olsa bile payload açılmaz).
- **Doğrulama (tatbikatta manuel):** `MASTER_KEY`'in çevrimdışı kopyasından tek bir kaydın
  reveal edilebildiğini teyit et (uygulama üzerinden; anahtarı log'a/ekrana düz yazma).

> **Kısacası:** DB yedeği + WAL bir kasada, `MASTER_KEY` **başka** bir kasada. İkisi bir arada
> asla aynı sırt çantasında taşınmaz.

---

## 4. Yedek alma

### 4.1 Elle mantıksal yedek (hızlı, taşınabilir)
`backup-drill.sh` zaten bunu yapıp doğruluyor. Bağımsız almak için:
```bash
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" lisans-yonetim-paneli-postgres-1 \
  pg_dump -Fc --no-owner --no-privileges -U lisanspanel -d lisanspanel \
  > backups/lisanspanel_$(date +%Y%m%d-%H%M%S).dump
```
- `-Fc` (custom) = sıkıştırılmış, seçmeli/paralel restore edilebilir.
- Dump'ı **offsite** kopyala (S3/başka bölge). Host'ta kalan yedek, host kaybında işe yaramaz.

### 4.2 Sürekli WAL (PITR — RPO≤5dk hedefi) → **§2.2 pgBackRest kurulunca**
Mantıksal dump anlıktır; iki dump arasındaki veri PITR olmadan kurtarılamaz. RPO≤5dk yalnız WAL
arşivleme ile sağlanır. Kurulum §2.2'de.

---

### 4.3 Panelden yedek alma (SSH'siz — `backup-runner.sh` ile) · **ÖNERİLEN**

Panelde **Dağıtımlar (/deployments)** → *Yedekler* bölümü:

| Düğme (owner-only) | Kuyruk hedefi | Host'ta koşan |
|---|---|---|
| **Şimdi yedek al** | `backup` | `BACKUP_ONLY=1 scripts/backup-drill.sh` — dump + arşiv bütünlüğü + offsite kancası + rotasyon |
| **Tatbikat çalıştır** | `backup-drill` | `scripts/backup-drill.sh` — yukarıdakiler + ayrı `*_drill` DB'sine geri yükleme, satır sayıları, **çifte-atama=0**, RTO ölçümü |

Aynı ekranda **"Son yedek"** ve **"Son tatbikat"** kartları: ne zaman, ne kadar sürdü, boyut,
dış kopya durumu, tatbikatta geri-yükleme süresi (RTO). Yedek yoksa ya da eşiği aştıysa
**kırmızı uyarı bandı** çıkar (yedek > **26 saat**, tatbikat > **35 gün**).

**Mimari (değişmez kural):** panel **yalnız bir istek kaydeder**; `pg_dump`'ı host'taki runner
çalıştırır. Panel konteynerine Docker soketi / DB kabuğu **VERİLMEZ** (konteynerden host'a tam
erişim riski). Dağıtımdaki istek/çalıştırma ayrımının aynısıdır ve **aynı kuyruğu** kullanır:

```
panel (POST /v1/admin/deployments, target=backup)   →  status=pending
host cron: backup-runner.sh → POST .../claim {"targets":["backup","backup-drill"]}
                                                    →  status=running (FOR UPDATE SKIP LOCKED)
           backup-drill.sh koşar
           PATCH .../<id>/finish {status, log, gitSha}  →  success | failed
```

Sözleşmenin taşıdığı güvenceler (dağıtımla **ortak**, ayrı yol açılmadı):
* **Aynı anda tek aktif iş** — yedek alınırken dağıtım (ya da tersi) başlatılamaz (409).
  Nedeni yalnız yığılma değil: `deploy.sh` servisleri yeniden başlatırsa dump yarıda kalır.
* **Zombi temizliği (HEDEFE GÖRE)** — `running` kalmış kayıt, işin doğasına göre seçilmiş
  eşiği aşınca otomatik `failed` olur ve kilit açılır: **dağıtım/eklenti 30 dk · `backup`
  2 saat · `backup-drill` 4 saat**. Tek 30 dk'lık eşik yanlıştı: RTO hedefi **2 saat** olan bir
  tatbikat 30. dakikada "başarısız" damgalanıp kilidi açıyor, ardından `deploy.sh` tatbikatla
  aynı anda koşabiliyordu (`docker build/up` ⟷ `pg_restore`). Temizlik hem runner'ın
  `claim` çağrısında hem de yeni istek yolunda koşar (her iki runner da ölse kilit açılır).
* **Geç bildirim ezmez (CAS)** — zombi olarak kapatılmış bir işin sonucu sonradan gelirse
  durum **değişmez**; kayda `[GEÇ BİLDİRİM]` notu düşer ve API logunda `error` seviyesinde
  görünür. Böyle bir kayıt görürsen: iş eşikten uzun sürmüştür ve o aralıkta başka bir iş
  koşmuş olabilir — `docs/DEPLOY-LOG.md` ile karşılaştır.
* **Owner-only** — istek ucu Next `isOwner()` + API `OwnerGuard` ile korunur.

**Runner kurulumu (VPS'te, bir kez):**
```bash
apt-get install -y jq                      # gerekli (JSON)
crontab -e
# 1) panelden tetiklenen yedek isteklerini dakikada bir yoklar:
* * * * * /opt/lisans-yonetim-paneli/scripts/backup-runner.sh >> /var/log/backup-runner.log 2>&1
# 2) GECELİK otomatik yedek (kendi isteğini kuyruğa yazar → panelde görünür):
15 3 * * * /opt/lisans-yonetim-paneli/scripts/backup-runner.sh --nightly >> /var/log/backup-runner.log 2>&1
# 3) AYLIK tatbikat (her ayın 1'i):
45 3 1 * * /opt/lisans-yonetim-paneli/scripts/backup-runner.sh --enqueue backup-drill >> /var/log/backup-runner.log 2>&1
```

> **Cron satırına `flock` EKLEME.** Runner tek-örnek kilidini kendi alır
> (`/tmp/wpteslimat-backup-runner.self.lock`). İkinci bir dış kilit katmanı eklenirse betik
> kendi kendini kilitler ve iş **sessizce hiç koşmaz** (dağıtım runner'ında yaşanan hata).
> Kilit dosyası `deploy-runner.sh`'ınkinden AYRIDIR: yedek ile dağıtım birbirini bloklamaz
> (kuyruk zaten tek aktif işe izin verir), ama iki yedek asla üst üste binmez.

Runner `ADMIN_TOKEN`'ı repo kökündeki `.env`'den okur (dağıtım runner'ıyla aynı). Ayarlar
ortamdan **veya** `.env`'den okunur:

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `BACKUP_DIR` | `<repo>/backups` | Dump dizini |
| `BACKUP_KEEP_LAST` | **14** (runner) / 0 (elle koşum) | **ROTASYON**: en yeni N dump tutulur, eskiler silinir |
| `BACKUP_OFFSITE_CMD` | — | **Offsite kancası** (§4.4) |
| `BACKUP_OFFSITE_TIMEOUT` | 900 | Offsite komutu saniye sınırı |
| `BACKUP_RUNNER_API` | prod API URL | Panel API tabanı |
| `BACKUP_RUNNER_FAIL_WARN` | 5 | Kaç **ardışık** API hatasından sonra cron loguna büyük uyarı bloğu basılsın |

> **`.env` dosyanız CRLF ise dikkat.** Proje Windows'ta geliştiriliyor; CRLF satır sonlu bir
> `.env`'de değerin sonuna görünmez bir `\r` yapışır. `ADMIN_TOKEN`'ın sonundaki `\r`
> **tüm API çağrılarını** reddettirir → yedek hiç alınmaz. Runner ve `backup-drill.sh` artık
> `\r`'yi soyuyor, ama şüphelenirsen: `file .env` (→ "CRLF line terminators") ya da
> `grep -c $'\r' .env`. Aynı şekilde `BACKUP_KEEP_LAST=14 # iki hafta` gibi **satır-içi
> yorum** yazma: sayısal ayarlar artık temizleniyor ve geçersizse uyarı basıyor, ama en
> temizi yorumu ayrı satıra almaktır.

**Yedek yolu SESSİZ ölmez (§16 alarm zinciri).** Yedek/tatbikat tazeliği artık yalnız
`/deployments` ekranında değil, **bildirim + (env varsa) Telegram** kanalında da görünür:

| Alarm | Tip | Eşik | Önem | Dedupe |
|---|---|---|---|---|
| Yedek bayat / hiç yok | `backup_stale` | > 26 saat | **critical** | 24 saat |
| Tatbikat bayat / hiç yok | `drill_stale` | > 35 gün | warning | 7 gün |

Tarama 6 saatte bir koşar (`backup-alarm` kuyruğu) ve kendisi patlarsa diğer sweep'ler gibi
`sweep_failed` kritik alarmı üretir. **Kurulum doğrulaması (bir kez, kurulumdan sonra ŞART):**

```bash
# Alarm kanalı gerçekten çalışıyor mu? (yalnız bildirim üretir — yedek ALMAZ)
curl -sS -X POST -H "X-Admin-Token: $ADMIN_TOKEN" \
  https://<panel-api>/v1/admin/deployments/backup-alarm/run
# → {"created":N}. Yedek hiç alınmamışsa N>0 ve /notifications'ta 'backup_stale' görünmeli
#   (Telegram env tanımlıysa mesaj da düşmeli). Bu adım atlanırsa "alarm var sanıp sessiz
#   kalmak" riski sürer — yedeğin yokluğu ancak ihtiyaç anında fark edilen arıza sınıfıdır.
```

**Rotasyon (disk):** günlük yedek + rotasyon kapalı = disk **sessizce dolar** ve bir gün prod
durur. Runner varsayılanı `BACKUP_KEEP_LAST=14` (≈2 hafta günlük yedek). Yalnız bu betiğin
ürettiği `"<db>_YYYYmmdd-HHMMSS.dump"` dosyaları budanır; başka dosyalara dokunulmaz.
Disk boyutunu hesapla: `14 × (bir dump boyutu)` — panelde "Boyut" satırı gerçek değeri gösterir.

**Rotasyon YALNIZ hatasız koşumda çalışır.** Koşumda bir `[FAIL]` varsa (ör. arşiv okunamadı,
sürüm uyuşmazlığı) eski dump'lar **silinmez** ve `[WARN] Rotasyon ATLANDI` basılır. Sebep:
kalıcı bir arızada her gece FAIL raporlanırken her gece pencereden bir **doğrulanmış** dump
düşerdi; 14 gecede elde yalnız doğrulanamamış dump kalırdı. Bu durumda **diski izle** ve
kök nedeni gider (§7.5); disk dolma riski, tek doğrulanmış yedeği kaybetme riskinden küçüktür.

**Runner sessiz kalmaz (çıkış kodları).** `backup-runner.sh` artık HTTP kodunu okur:
`0` = yapacak iş yoktu / iş koşuldu ve sonucu panele yazıldı · `1` = **panel API'sine
ulaşılamadı ya da yapılandırma eksik** (log/cron maili). "Kuyrukta aktif iş var" (409) ile
"401 / ağ hatası" artık ayrı raporlanır; 5 ardışık hatadan sonra loga büyük bir uyarı bloğu
basılır. Teşhis sırası: `tail -50 /var/log/backup-runner.log` → `ADMIN_TOKEN` geçerli mi →
`curl -sS <API>/v1/health` → `.env` CRLF mi.

**MASTER_KEY (§3) — yedeğin İÇİNDE DEĞİL:** runner yalnız veritabanını dump eder; `.env`'e ve
anahtar dosyalarına **dokunmaz**, offsite kancasına da **yalnız dump dosyasının yolunu** verir.
Anahtar ayrı kasada saklanır (§3). Bu kural yedek otomatikleştiği için daha da kritiktir:
otomatik yedek + yanına konmuş anahtar = tek dosyada tüm lisansların sızması.

---

### 4.4 OFFSITE kancası (`BACKUP_OFFSITE_CMD`) · **kurulması ŞART**

Host diskinde duran yedek, **host kaybı** senaryosunda (§7.1) hiçbir işe yaramaz. Panel/betik
içine sağlayıcıya özel bir entegrasyon **gömülmez** (kimlik bilgisi gerektirir, uydurulamaz):
operatör kendi aracını bir kanca ile bağlar.

**Sözleşme:** komut, dump alındıktan hemen sonra **dump dosyasının tam yolu tek argüman**
olacak şekilde çalıştırılır:
```
<BACKUP_OFFSITE_CMD> /opt/lisans-yonetim-paneli/backups/lisanspanel_20260814-030000.dump
```
* Değer kelime bölmeli genişletilir (argümanlı komut yazılabilir); **`eval` KULLANILMAZ**,
  kabuk metakarakteri (`;`, `|`, `$(…)`) yorumlanmaz.
* Çıkış kodu 0 → panelde **"Dışarı kopyalandı"**; ≠0 → **"Dış kopya BAŞARISIZ"** (yedek yine de
  host'ta durur, iş `failed` OLMAZ — dürüst uyarı verilir). Kanca tanımsızsa "Dış kopya yok".
* `BACKUP_OFFSITE_TIMEOUT` (vars. 900 sn) ile sınırlanır → takılan yükleme runner'ı kilitlemez.

**ÖNERİLEN: 3 satırlık bir sarmalayıcı betik.** `rclone`/`scp`/`rsync`/`aws s3` gibi araçlar
**hedefi SON argüman** bekler; kanca ise dump yolunu son argüman olarak ekler. Bu yüzden onları
doğrudan `BACKUP_OFFSITE_CMD`'ye yazma — kimlik bilgisi de sarmalayıcıda kalsın (`.env`'de
parola tutma):

```bash
cat > /usr/local/bin/offsite-upload.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
# $1 = dump dosyasının tam yolu. Aşağıdakilerden BİRİNİ seç:
exec rclone copy --config /root/.config/rclone/rclone.conf "$1" uzak-depo:lisans-yedek/
# exec aws s3 cp "$1" s3://benim-bucket/lisans-yedek/
# exec scp -i /root/.ssh/offsite_key -o BatchMode=yes "$1" yedek@baska-sunucu:/backups/
SH
chmod 700 /usr/local/bin/offsite-upload.sh
# .env'e ekle (ya da cron ortamında ver):
echo 'BACKUP_OFFSITE_CMD=/usr/local/bin/offsite-upload.sh' >> /opt/lisans-yonetim-paneli/.env
```

> **Şifreleme:** offsite hedef senin tam kontrolünde değilse dump'ı yüklemeden ÖNCE şifrele
> (ör. `age`/`gpg`, sarmalayıcının içinde) — yedek müşteri e-postalarını ve şifreli lisans
> payload'larını içerir. Şifreleme anahtarı da `MASTER_KEY` gibi **AYRI kasada** saklanır.
> **Uyarı:** kanca yalnız dump dosyasını alır; `.env` / `MASTER_KEY` offsite'a **gönderilmez**
> ve gönderilmemelidir (§3).

**Kurulumdan sonra doğrula:** panelden **Şimdi yedek al** → kart "Dış kopya: Dışarı kopyalandı"
demeli; hedefte dosyayı gözle gör (boyut panelde yazan ile aynı mı).

---

## 5. Geri-yükleme prosedürü (adım adım)

> **Altın kural:** Prod veritabanı (`lisanspanel`) üzerine restore etmeden ÖNCE, mümkünse mevcut
> durumu bir kenara al (yeni ada rename / ayrı dump). Geri yükleme **yıkıcıdır**; yanlış hedefe
> restore ikinci bir felakettir. `backup-drill.sh` prod'a asla dokunmaz — elle restore'da dikkat sende.

### 5.1 Ön koşullar
- Erişilebilir yedek dosyası (`backups/*.dump`) **veya** pgBackRest repo (offsite S3).
- `MASTER_KEY`'in çevrimdışı kopyası (aksi halde payload'lar açılmaz — §3).
- Çalışan bir PostgreSQL 17 (yeni container veya yeni VPS).

### 5.2 Mantıksal dump'tan geri yükleme (yeni/boş DB'ye)
```bash
# 1) Hedef DB'yi oluştur (boş).  Prod adına restore edeceksen ÖNCE eskiyi yedekle/yeniden adlandır.
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" lisans-yonetim-paneli-postgres-1 \
  psql -U lisanspanel -d postgres -c 'CREATE DATABASE lisanspanel_restore;'

# 2) Geri yükle
docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" lisans-yonetim-paneli-postgres-1 \
  pg_restore --no-owner --no-privileges -d lisanspanel_restore < backups/<DOSYA>.dump

# 3) Doğrula (satır sayıları + çifte-atama=0) — bkz. backup-drill.sh §5 sorguları
# 4) Uygulamayı yeni DB'ye yönelt (DATABASE_URL) VEYA restore DB'yi prod adına al (bakım penceresi).
```

### 5.3 PITR (noktaya-dönük) — pgBackRest kurulduysa
```bash
# Hizmeti durdur, veriyi temizle, hedef zamana restore et:
pgbackrest --stanza=lisanspanel --delta --type=time \
  --target='2026-07-21 09:55:00+00' restore
# PostgreSQL'i başlat → recovery hedef zamana kadar WAL oynatır (RPO≤5dk).
```

### 5.4 Uygulamayı ayağa kaldırma
- `MASTER_KEY` + diğer sırlar `.env`'e konur (yedekten DEĞİL, ayrı secret store'dan — §3).
- `docker compose up -d` → API açılışta migration'ları uygular (`node dist/db/migrate.js`).
- Duman testi: bir kayıt reveal (payload çözülüyor mu = `MASTER_KEY` doğru mu), yeni sipariş push.

---

## 6. Aylık tatbikat kontrol listesi

Her ayın ilk iş günü (öneri) uygulanır. Amaç: yedeğin gerçekten geri yüklenebilir + tutarlı
olduğunu, RTO'nun hedefte kaldığını kanıtlamak.

- [ ] **Çalıştır:** panelde **/deployments → Yedekler → "Tatbikat çalıştır"** (owner).
      Tatbikatın zombi eşiği **4 saat**'tir (RTO hedefi 2 saat) — 30 dk'yı aşan koşum artık
      "başarısız" damgalanmaz. SSH alternatifi (runner kurulu değilse):
      ```bash
      bash scripts/backup-drill.sh
      ```
      (Docker'sız / uzak PG için: `PG_HOST=... PG_PORT=... PG_USER=... PG_DB=... PG_PASSWORD=... bash scripts/backup-drill.sh`)
- [ ] **PASS doğrula:** çıktının son satırı `SONUC: PASS`, `FAIL=0`. Panelden koştuysan
      /deployments'ta iş **"Başarılı"** ve "Son tatbikat" kartı tazelenmiş olmalı (log da orada).
- [ ] **Panel bandı söndü mü:** /deployments'ta kırmızı "yedek yok/bayat" ya da sarı "tatbikat
      bayat" bandı kalmamalı. Bant duruyorsa eşik aşılmış demektir — sebebini kapat (cron?
      runner? offsite?), sonraki aya erteleme.
- [ ] **Alarm kanalı canlı mı:** `/notifications`'ta çözülmemiş `backup_stale` / `drill_stale`
      kaydı kalmamalı. Kanalın kendisini yılda bir kez tetikleyerek doğrula
      (`POST /v1/admin/deployments/backup-alarm/run`, §4.3) — **alarmın sessizliği ile
      alarmın ölmüş olması dışarıdan aynı görünür.**
- [ ] **Cron logu temiz mi:** `grep -c 'backup-runner:' /var/log/backup-runner.log` ve
      son 50 satırda `DİKKAT:`/`BAŞARISIZ` bloğu var mı? (Runner artık API hatasında `1`
      döner ve stderr'e yazar; boş log = cron hiç koşmuyor demektir.)
- [ ] **RTO gözlemi:** "Geri-yükleme (RTO): Ns" değeri hedefin (7200s) çok altında mı? Trend not et.
- [ ] **Çifte-atama = 0** satırı PASS mı? (Değilse §7'ye eskale — veri bütünlüğü ihlali.)
- [ ] **Offsite kopya** güncel mi? Panelde "Dış kopya: **Dışarı kopyalandı**" yazmalı; hedefte
      dosyayı gözle doğrula. "Dış kopya yok" görüyorsan kanca kurulmamıştır → §4.4.
- [ ] **MASTER_KEY tatbikatı (§3):** çevrimdışı anahtar kopyasından tek kayıt reveal edilebildi mi? (Anahtar erişimini teyit; değeri yazma.)
- [ ] **Sonucu kaydet:** aşağıdaki tabloya satır ekle.

| Tarih | Çalıştıran | Sonuç | RTO (s) | Dump (bayt) | Offsite OK | Not |
|---|---|---|---|---|---|---|
| YYYY-MM-DD |  | PASS/FAIL |  |  | evet/hayir |  |

> `backup-drill.sh` doğrulama sonunda **her zaman `*_drill` DB'sini düşürür** ve prod'a hiç dokunmaz;
> aylık koşum prod trafiğini etkilemez (yalnız okuma + pg_dump yükü).

---

## 7. Felaket senaryoları & kurtarma

### 7.1 Disk / host kaybı (pgdata gitti)
1. Yeni VPS + Docker hazırla. `.env`'i (sırlar + `MASTER_KEY`, ayrı secret store'dan — §3) yerleştir.
2. **PITR varsa:** pgBackRest restore (§5.3) → son WAL'a kadar (RPO≤5dk).
   **Yoksa:** en yeni offsite `*.dump` ile §5.2 (RPO = son dump anı — bu yüzden §2.2 WAL şart).
3. `docker compose up -d`, migration otomatik, duman testi (reveal + sipariş).
4. Kayıp penceresini (son yedek → felaket) not et; etkilenen siparişleri WP tarafıyla mutabık kıl.

### 7.2 Yanlış / kazara DROP (tablo veya DB silindi)
1. Panikleme; **yeni yazımları durdur** (API'yi durdur / bakım moduna al) — yoksa RPO büyür.
2. **PITR varsa:** DROP'tan **hemen önceki** ana restore (§5.3, `--target` = olay zamanı - 1sn).
   Bu en az veri kaybını verir.
   **Yoksa:** en yeni dump'ı ayrı DB'ye restore (§5.2), eksik veriyi elle taşı/mutabık kıl.
3. `backup-drill.sh` benzeri doğrulama (çifte-atama=0, satır sayıları) çalıştır.
4. Kök neden: yıkıcı komutları yalnız `*_drill`/geçici hedeflerde çalıştır kuralını hatırlat.

### 7.3 Container kaybı (pgdata volume sağlam)
- En hafif senaryo: `docker compose up -d postgres` volume'u yeniden bağlar; veri yerinde.
- Doğrula: `docker exec ... pg_isready`, satır sayıları, `backup-drill.sh` (PASS).

### 7.4 MASTER_KEY kaybı (DB sağlam)
- **Kurtarılamaz:** payload'lar AES-256-GCM ile şifreli; anahtar yoksa çözülmez (§8 — tasarım gereği).
- Bu yüzden §3: anahtar **çevrimdışı en az 2 kopya**. Kayıp riski yedek kaybından daha ölümcüldür.
- Anahtar kaybında: yeni anahtar üret, stok yeniden içe aktar (eski şifreli payload'lar ölü veridir),
  müşteri değişim akışını (§13) devreye al.

### 7.5 Yedek bozuk / restore FAIL (tatbikatta yakalandı)
- `backup-drill.sh` FAIL verdi: `backups/.restore_*.log`'a bak, arşiv TOC (`pg_restore -l`) girdisi
  ve satır sayılarını incele. Bir önceki sağlam dump'a/pgBackRest'e düş; yedek pipeline'ını onar;
  onarımdan sonra tatbikatı tekrarla → PASS almadan ay kapanmaz.

---

## 8. Hızlı referans

| İşlem | Komut |
|---|---|
| **Panelden yedek / tatbikat** | /deployments → *Yedekler* (owner) — kurulum §4.3 |
| Yalnız yedek al (host) | `BACKUP_ONLY=1 bash scripts/backup-drill.sh` |
| Aylık tatbikat | `bash scripts/backup-drill.sh` |
| Yedek runner'ı elle koştur | `bash scripts/backup-runner.sh` (kuyruktaki isteği alır) |
| Kuyruğa yedek yaz + koştur | `bash scripts/backup-runner.sh --nightly` |
| Kuyruğa tatbikat yaz + koştur | `bash scripts/backup-runner.sh --enqueue backup-drill` |
| Runner logu | `tail -f /var/log/backup-runner.log` |
| Docker'sız tatbikat | `PG_HOST=.. PG_DB=.. PG_USER=.. PG_PASSWORD=.. bash scripts/backup-drill.sh` |
| Elle dump | bkz. §4.1 |
| Restore (yeni DB) | bkz. §5.2 |
| PITR restore | bkz. §5.3 (pgBackRest) |
| Prod DB / kullanıcı | `lisanspanel` / `lisanspanel` (`.env`: `POSTGRES_DB`/`POSTGRES_USER`) |
| Postgres container | `lisans-yonetim-paneli-postgres-1` |

> **İki cümlelik DR özeti:** DB yedeği + WAL bir kasada, `MASTER_KEY` başka kasada; ikisi olmadan
> ne veri ne de anlam kurtarılır. Her ay `backup-drill.sh` ile geri yüklenebilirliği kanıtla, PASS'ı kaydet.
