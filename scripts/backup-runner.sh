#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# backup-runner.sh — VPS HOST'unda çalışan YEDEK işçisi (§16 DR).
#
# `deploy-runner.sh` ile BİREBİR aynı desen: panel yalnız bir İSTEK kaydeder, host'taki bu
# betik isteği ATOMİK olarak claim eder (pending→running), ilgili betiği çalıştırır ve sonucu
# panele geri yazar (success/failed + log). Panel konteynerine Docker soketi / DB erişimi
# VERİLMEZ — panelden ASLA `pg_dump` çalıştırılmaz; istek (panel) ile çalıştırma (host) ayrıdır.
#
# HEDEFLER (claim yanıtındaki `target`):
#   • "backup"       → BACKUP_ONLY=1 scripts/backup-drill.sh   (yalnız yedek al + arşiv
#                      bütünlüğü + offsite kancası + rotasyon; geri-yükleme doğrulaması YOK)
#   • "backup-drill" → scripts/backup-drill.sh                 (TAM tatbikat: ayrı `*_drill`
#                      DB'sine geri yükle, satır sayıları + çifte-atama=0 doğrula, RTO ölç)
#
# Bu runner YALNIZ bu iki hedefi claim eder (`targets` filtresi). Neden ŞART: aynı kuyruğu
# `deploy-runner.sh` de yokluyor; filtre olmasaydı yedek runner'ı bir `api admin` isteğini
# kapar, claim geri alınamadığı için istek "çalıştı ama dağıtım olmadı" diye kaybolurdu.
#
# KURULUM (VPS'te, bir kez) — cron:
#   crontab -e →
#   # panelden tetiklenen yedek isteklerini dakikada bir yoklar:
#   * * * * * /opt/lisans-yonetim-paneli/scripts/backup-runner.sh >> /var/log/backup-runner.log 2>&1
#   # GECELİK OTOMATİK yedek (kendi isteğini kuyruğa yazar → panelde görünür):
#   15 3 * * * /opt/lisans-yonetim-paneli/scripts/backup-runner.sh --nightly >> /var/log/backup-runner.log 2>&1
#   # AYLIK tatbikat (her ayın 1'i):
#   45 3 1 * * /opt/lisans-yonetim-paneli/scripts/backup-runner.sh --enqueue backup-drill >> /var/log/backup-runner.log 2>&1
#
# Cron satırına DIŞ `flock` SARMALAYICISI EKLEME — betik kilidini KENDİ alır (deploy-runner'da
# yaşanan self-deadlock dersinin aynısı: iki flock katmanı AYNI dosyaya kurulunca betik kendi
# kendini kilitler ve iş sessizce hiç koşmaz).
#
# ENV (hepsi opsiyonel; repo kökündeki .env'den de okunur):
#   BACKUP_RUNNER_API      panel API tabanı (vars: DEPLOY_RUNNER_API ya da prod URL)
#   ADMIN_TOKEN            panel admin token'ı (ortam ya da .env)
#   BACKUP_DIR             dump dizini            (vars: <repo>/backups)
#   BACKUP_KEEP_LAST       ROTASYON: en yeni N dump tutulur (vars: 14 — ~2 hafta günlük yedek)
#   BACKUP_OFFSITE_CMD     OFFSITE KANCASI: dump yolu argüman olarak geçirilir (bkz. RUNBOOK-DR §4.4)
#   BACKUP_OFFSITE_TIMEOUT offsite komutu saniye sınırı (vars: 900)
#
# MASTER_KEY (§8 / RUNBOOK-DR §3): yedeğin İÇİNDE DEĞİLDİR ve OLMAMALIDIR. Bu runner yalnız
# veritabanını dump eder; `.env`'e, anahtar dosyalarına ya da MASTER_KEY'e HİÇ dokunmaz ve
# offsite kancasına da yalnız dump dosyasının yolunu verir. Anahtar AYRI kasada saklanır —
# yedek tek başına ele geçse bile payload'lar çözülemez. Anahtarı yedeğin yanına koymak
# şifrelemeyi anlamsız kılar (tek dosyada tüm lisansların sızması).
#
# Gerektirir: jq, curl (+ backup-drill.sh'ın gerektirdikleri: docker ya da psql/pg_dump).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.."   # repo kökü (/opt/lisans-yonetim-paneli)

API_BASE="${BACKUP_RUNNER_API:-${DEPLOY_RUNNER_API:-https://api.167-233-108-12.sslip.io}}"

# Tek örnek güvencesi — kilit BETİĞİN KENDİSİNE ait. Dosya adı deploy-runner'ınkinden AYRI:
# yedek ile dağıtım birbirini bloklamasın (kuyruk zaten aynı anda tek aktif işe izin verir),
# ama İKİ yedek asla üst üste binmesin (eşzamanlı pg_dump = boşuna disk + CPU).
exec 9>/tmp/wpteslimat-backup-runner.self.lock
if ! flock -n 9; then exit 0; fi

command -v jq >/dev/null 2>&1 || { echo "backup-runner: jq gerekli (apt install jq)"; exit 1; }

# .env'den anahtar okuma — `source` ETMEYİZ (MAIL_FROM gibi değerler '<'/'>' içerir ve
# sourcing bunları yönlendirme sanıp betiği patlatır; backup-drill.sh ile aynı desen).
read_env_var() { # $1=key → değer (çevresel tırnaklar soyulur), eval YOK
  local key="$1" ln val
  [ -f .env ] || return 0
  ln="$(grep -E "^[[:space:]]*${key}=" .env 2>/dev/null | tail -n1 || true)"
  [ -z "$ln" ] && return 0
  val="${ln#*=}"
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  printf '%s' "$val"
}

ADMIN_TOKEN="${ADMIN_TOKEN:-}"
[ -z "$ADMIN_TOKEN" ] && ADMIN_TOKEN="$(read_env_var ADMIN_TOKEN)"
[ -z "$ADMIN_TOKEN" ] && { echo "backup-runner: ADMIN_TOKEN bulunamadı (.env)"; exit 1; }

# Yedek ayarları: ortam > .env > varsayılan. Rotasyon VARSAYILAN OLARAK AÇIK (14) — kapalı
# bırakılırsa günlük dump'lar diski sessizce doldurur ve bir gün prod'u durdurur.
BACKUP_KEEP_LAST="${BACKUP_KEEP_LAST:-$(read_env_var BACKUP_KEEP_LAST)}"
[ -z "$BACKUP_KEEP_LAST" ] && BACKUP_KEEP_LAST=14
BACKUP_OFFSITE_CMD="${BACKUP_OFFSITE_CMD:-$(read_env_var BACKUP_OFFSITE_CMD)}"
BACKUP_OFFSITE_TIMEOUT="${BACKUP_OFFSITE_TIMEOUT:-$(read_env_var BACKUP_OFFSITE_TIMEOUT)}"
[ -z "$BACKUP_OFFSITE_TIMEOUT" ] && BACKUP_OFFSITE_TIMEOUT=900
BACKUP_DIR="${BACKUP_DIR:-$(read_env_var BACKUP_DIR)}"
export BACKUP_KEEP_LAST BACKUP_OFFSITE_CMD BACKUP_OFFSITE_TIMEOUT
[ -n "$BACKUP_DIR" ] && export BACKUP_DIR

api(){  # api METHOD PATH [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS --max-time 20 -X "$method" \
      -H "X-Admin-Token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
      -d "$body" "$API_BASE$path"
  else
    curl -fsS --max-time 20 -X "$method" -H "X-Admin-Token: $ADMIN_TOKEN" "$API_BASE$path"
  fi
}

# ── (Opsiyonel) KENDİ İSTEĞİNİ KUYRUĞA YAZ — gecelik/aylık otomatik koşum ────────────────
# Otomatik yedek de panelde GÖRÜNSÜN diye ayrı bir yol açılmaz: runner tam olarak operatörün
# panelden bastığı düğmenin yaptığını yapar (POST /deployments). Böylece "son yedek ne zaman"
# sorusu tek kaynaktan (deployments kuyruğu) yanıtlanır.
ENQUEUE=""
case "${1:-}" in
  --nightly)  ENQUEUE="backup" ;;
  --enqueue)  ENQUEUE="${2:-backup}" ;;
  "")         : ;;
  *)          echo "backup-runner: bilinmeyen argüman '${1}' (kullanım: [--nightly | --enqueue <backup|backup-drill>])"; exit 1 ;;
esac

if [ -n "$ENQUEUE" ]; then
  case "$ENQUEUE" in
    backup|backup-drill) : ;;
    *) echo "backup-runner: geçersiz hedef '$ENQUEUE' (backup | backup-drill)"; exit 1 ;;
  esac
  req_body="$(jq -n --arg t "$ENQUEUE" '{target:$t, note:"otomatik koşum (cron)"}')"
  if api POST /v1/admin/deployments "$req_body" >/dev/null 2>&1; then
    echo "[$(date '+%F %T')] backup-runner: '$ENQUEUE' isteği kuyruğa yazıldı (otomatik)"
  else
    # En olası neden 409: kuyrukta zaten aktif bir iş var (dağıtım ya da yedek). Bu bir hata
    # DEĞİL — sıradaki koşum devralır. Yine de claim adımına devam ederiz: bekleyen yedek
    # isteği varsa (panelden ya da önceki koşumdan) onu çalıştırırız.
    echo "[$(date '+%F %T')] backup-runner: istek kaydedilemedi (muhtemelen kuyrukta aktif iş var) — claim'e devam"
  fi
fi

# ── 1) Bekleyen YEDEK isteğini ATOMİK al (pending→running) ───────────────────────────────
# targets filtresi ŞART: dağıtım isteklerine dokunmayız (bkz. başlık).
claim="$(api POST /v1/admin/deployments/claim '{"targets":["backup","backup-drill"]}' || echo '{}')"
id="$(printf '%s' "$claim" | jq -r '.id // empty' 2>/dev/null)"
[ -z "$id" ] && exit 0

target="$(printf '%s' "$claim" | jq -r '.target // "backup"' 2>/dev/null)"

# ── 2) İlgili modda backup-drill.sh'ı çalıştır ───────────────────────────────────────────
if [ ! -x ./scripts/backup-drill.sh ]; then
  # Sessiz takılma yerine anlamlı hata (repo güncel mi, exec biti korunmuş mu?).
  out="backup-drill.sh bulunamadı veya çalıştırılabilir değil — repo güncel mi? (git pull)"
  code=1
elif [ "$target" = "backup-drill" ]; then
  echo "[$(date '+%F %T')] backup-runner: claim $id → backup-drill.sh (TAM tatbikat)"
  out="$(./scripts/backup-drill.sh 2>&1)"; code=$?
else
  echo "[$(date '+%F %T')] backup-runner: claim $id → backup-drill.sh (BACKUP_ONLY=1)"
  out="$(BACKUP_ONLY=1 ./scripts/backup-drill.sh 2>&1)"; code=$?
fi

# Kalan ANSI escape kodlarını soy (log panelde ham gösteriliyor).
out="$(printf '%s' "$out" | sed -E 's/\x1b\[[0-9;]*m//g')"
# Hangi kod sürümüyle alındığı izlenebilsin (dump formatı/şema sürümü ile eşleştirme).
sha="$(git rev-parse --short HEAD 2>/dev/null || echo '')"

status="success"; err=""
if [ "$code" -ne 0 ]; then
  status="failed"
  err="$(printf '%s' "$out" | grep -E '\[FAIL\]|SONUC: FAIL|HATA|GÜVENLİK' | tail -1)"
  [ -z "$err" ] && err="backup-drill.sh çıkış kodu $code"
fi

# ── 3) Sonucu panele geri yaz ────────────────────────────────────────────────────────────
# log/error jq İÇİNDE codepoint bazlı kırpılır (controller z.string().max + servis .slice ile
# hizalı; `tail -c` multibyte ortasından keserse jq'yu bozacak geçersiz UTF-8 üretirdi).
# DİKKAT: panel özeti (BACKUP_FILE=/BACKUP_BYTES=/…) çıktının SONUNDA basılır ve kırpma
# SONDAN saklama yaptığı için korunur — API özeti bu satırlardan okur.
body="$(jq -n --arg s "$status" --arg sha "$sha" --arg log "$out" --arg e "$err" \
  '{status:$s, gitSha:$sha, log:($log | if length > 20000 then .[-20000:] else . end)}
   + (if $e=="" then {} else {error:($e | if length > 4000 then .[-4000:] else . end)} end)')"
for attempt in 1 2 3; do
  if api PATCH "/v1/admin/deployments/$id/finish" "$body" >/dev/null; then
    echo "[$(date '+%F %T')] backup-runner: $id → $status (bildirildi)"
    break
  fi
  echo "[$(date '+%F %T')] backup-runner: finish PATCH denemesi $attempt başarısız, tekrar…"
  sleep 5
done

exit 0
