# RUNBOOK — Felaket Kurtarma (DR) & Yedek Tatbikatı

> Jetlisans Merkezi Lisans Paneli · MIMARI.md **§16** (Operasyon: test, sürüm, DR) + **§8** (Güvenlik).
> Bu belge operasyoneldir: VPS'te elle uygulanır. Otomatik doğrulama scripti: `scripts/backup-drill.sh`.

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
- Ayrık, otomatik, offsite yedek **henüz kurulu değil** — volume host diskinde yaşar.
- Bu, tek nokta arızasıdır: disk/host kaybı = veri kaybı. `backup-drill.sh` bu boşlukta
  düzenli mantıksal yedek + doğrulama sağlar ama **PITR (RPO≤5dk) vermez.**

### 2.2 Hedef (MIMARI.md §1 tasarımı) — **öneri, kurulacak**
> §1: "Yedek: **pgBackRest** → offsite **S3** + sürekli **WAL** (PITR); master key AYRI saklanır."

1. **pgBackRest** kur (repo = offsite S3/B2/Wasabi bucket, `repo1-retention-full`, sıkıştırma+şifreleme).
2. PostgreSQL `archive_mode=on` + `archive_command = 'pgbackrest --stanza=jetlisans archive-push %p'`
   → her WAL segmenti offsite'a itilir ⇒ **RPO ≤ 5 dk** (`archive_timeout=60s` ile en fazla ~1dk WAL gecikmesi).
3. Günlük `full`/`diff`, saatlik `incr` yedek (cron). Restore: `pgbackrest --stanza=jetlisans restore`
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
pgbackrest --stanza=jetlisans --delta --type=time \
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

- [ ] **Çalıştır:** VPS'te repo kökünde
      ```bash
      bash scripts/backup-drill.sh
      ```
      (Docker'sız / uzak PG için: `PG_HOST=... PG_PORT=... PG_USER=... PG_DB=... PG_PASSWORD=... bash scripts/backup-drill.sh`)
- [ ] **PASS doğrula:** çıktının son satırı `SONUC: PASS`, `FAIL=0`.
- [ ] **RTO gözlemi:** "Geri-yükleme (RTO): Ns" değeri hedefin (7200s) çok altında mı? Trend not et.
- [ ] **Çifte-atama = 0** satırı PASS mı? (Değilse §7'ye eskale — veri bütünlüğü ihlali.)
- [ ] **Offsite kopya** güncel mi? (En yeni `backups/*.dump` S3/dış bölgeye kopyalandı mı; pgBackRest repo erişilebilir mi.)
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
| Aylık tatbikat | `bash scripts/backup-drill.sh` |
| Docker'sız tatbikat | `PG_HOST=.. PG_DB=.. PG_USER=.. PG_PASSWORD=.. bash scripts/backup-drill.sh` |
| Elle dump | bkz. §4.1 |
| Restore (yeni DB) | bkz. §5.2 |
| PITR restore | bkz. §5.3 (pgBackRest) |
| Prod DB / kullanıcı | `lisanspanel` / `lisanspanel` (`.env`: `POSTGRES_DB`/`POSTGRES_USER`) |
| Postgres container | `lisans-yonetim-paneli-postgres-1` |

> **İki cümlelik DR özeti:** DB yedeği + WAL bir kasada, `MASTER_KEY` başka kasada; ikisi olmadan
> ne veri ne de anlam kurtarılır. Her ay `backup-drill.sh` ile geri yüklenebilirliği kanıtla, PASS'ı kaydet.
