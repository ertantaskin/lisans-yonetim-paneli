#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-runner.sh — VPS HOST'unda çalışan dağıtım işçisi (§16). Panelden gelen
# istekleri işler: bekleyen isteği alır → ilgili betiği çalıştırır → sonucu panele
# geri yazar. Panel konteynerine Docker soketi VERİLMEZ (güvenlik: konteynerden host'a
# tam erişim demek olurdu) — bu ayrım tam da bu yüzden.
#
# İKİ HEDEF SINIFI (claim yanıtındaki `target` alanına göre dallanır):
#   • "plugin"        → ./scripts/publish-plugin.sh "<note>"  — WP eklentisini repo HEAD'inden
#                       paketleyip panele yayınlar (sürüm artırmaz, commit/push YAPMAZ; prod
#                       checkout'unda git kimliği/kimlik bilgisi yoktur ve yerel commit bir
#                       sonraki `deploy.sh` pull'unu kırardı). `note` = changelog metni.
#   • diğer (api/admin/…) → ./scripts/deploy.sh <target>      — panelin kendisini dağıtır.
#
# KURULUM (VPS'te, bir kez): host cron'una dakikada bir ekle —
#   crontab -e →
#   * * * * * /opt/lisans-yonetim-paneli/scripts/deploy-runner.sh >> /var/log/deploy-runner.log 2>&1
#
# Cron satırında DIŞ `flock` SARMALAYICISI KULLANMA — betik kilidini KENDİ alır (aşağıda).
# Neden: flock kilidi "açık dosya tanımına" (open file description) bağlıdır; dış flock ile
# betiğin kendi `exec 9>` açılışı AYNI dosyanın İKİ AYRI tanımıdır ve birbiriyle ÇAKIŞIR.
# İkisi aynı dosyaya kurulduğunda betik kendi kendini kilitliyor, `flock -n 9` başarısız oluyor
# ve runner sessizce çıkıyordu → panelden istenen dağıtım HİÇ koşmuyor, istek 'pending'de kalıyordu.
# (Kilit dosyası ayrıca dış sarmalayıcının kullandığı addan AYRI tutuldu: eski crontab satırı
# hâlâ duruyorsa bile self-deadlock oluşmaz, tek-örnek güvencesi yine sağlanır.)
#
# Gerektirir: jq, curl, git, docker (deploy.sh için), base64 (publish-plugin.sh için).
# ADMIN_TOKEN repo kökündeki .env'den okunur.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.."   # repo kökü (/opt/lisans-yonetim-paneli)

API_BASE="${DEPLOY_RUNNER_API:-https://api.167-233-108-12.sslip.io}"

# Tek örnek güvencesi — kilit BETİĞİN KENDİSİNE ait (kurulum talimatından bağımsız çalışır).
# Dosya adı bilinçli olarak dokümandaki eski dış-flock adından FARKLI (yukarıdaki nota bak).
exec 9>/tmp/wpteslimat-deploy-runner.self.lock
if ! flock -n 9; then exit 0; fi

command -v jq >/dev/null 2>&1 || { echo "deploy-runner: jq gerekli (apt install jq)"; exit 1; }

# ADMIN_TOKEN: ortamdan ya da .env'den.
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
if [ -z "$ADMIN_TOKEN" ] && [ -f .env ]; then
  ADMIN_TOKEN="$(grep -E '^ADMIN_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d '\r"' )"
fi
[ -z "$ADMIN_TOKEN" ] && { echo "deploy-runner: ADMIN_TOKEN bulunamadı (.env)"; exit 1; }

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

# 1) Bekleyen isteği ATOMİK al (pending→running). Yoksa {} döner → çık.
# `targets` filtresi ŞART: aynı kuyruğu `backup-runner.sh` de yokluyor (yedek/tatbikat
# hedefleri). Filtre olmasaydı bu runner bir 'backup' isteğini kapıp `deploy.sh backup`
# çalıştırmaya kalkardı; claim geri alınamadığı için istek boşa harcanır ve yedek hiç
# alınmazdı. Alan API'de OPSİYONEL → eski panel sürümüyle de uyumlu (tüm hedefler).
claim="$(api POST /v1/admin/deployments/claim '{"targets":["api","admin","api admin","plugin"]}' || echo '{}')"
id="$(printf '%s' "$claim" | jq -r '.id // empty' 2>/dev/null)"
[ -z "$id" ] && exit 0

target="$(printf '%s' "$claim" | jq -r '.target // "api admin"' 2>/dev/null)"
# `note` yalnız eklenti yayınında anlamlı (changelog metni). Alan yoksa boş kalır →
# publish-plugin.sh varsayılan metne ("Sürüm <VER>") düşer; eski API ile de uyumlu.
note="$(printf '%s' "$claim" | jq -r '.note // empty' 2>/dev/null)"

# 2) Hedefe göre ilgili betiği çalıştır (çıktıyı yakala; betikler kendi hatalarını raporlar).
runner_script="deploy.sh"
if [ "$target" = "plugin" ]; then
  runner_script="publish-plugin.sh"
  echo "[$(date '+%F %T')] deploy-runner: claim $id → publish-plugin.sh (eklenti yayını)"
  if [ ! -x ./scripts/publish-plugin.sh ]; then
    # Panel bu hedefi sunuyor ama betik prod checkout'unda yok/çalıştırılabilir değil →
    # sessiz takılma yerine anlamlı hata (repo güncel mi, exec biti korunmuş mu?).
    out="publish-plugin.sh bulunamadı veya çalıştırılabilir değil — repo güncel mi? (git pull)"
    code=1
  else
    out="$(./scripts/publish-plugin.sh "$note" 2>&1)"; code=$?
  fi
else
  echo "[$(date '+%F %T')] deploy-runner: claim $id → deploy.sh $target"
  out="$(./scripts/deploy.sh $target 2>&1)"; code=$?
fi
# Kalan ANSI escape kodlarını soy (iki betik de TTY'siz renk basmaz — çift savunma).
out="$(printf '%s' "$out" | sed -E 's/\x1b\[[0-9;]*m//g')"
# HEAD sha'sı her iki hedefte de anlamlı: panel dağıtımında "hangi sürüm canlı",
# eklenti yayınında "zip HANGİ commit'ten paketlendi" (ikisi de pull SONRASI okunur).
sha="$(git rev-parse --short HEAD 2>/dev/null || echo '')"
status="success"; err=""
if [ "$code" -ne 0 ]; then
  status="failed"
  err="$(printf '%s' "$out" | grep -E '✗|BAŞARISIZ|FAIL' | tail -1)"
  [ -z "$err" ] && err="$runner_script çıkış kodu $code"
fi

# 3) Sonucu panele geri yaz (jq ile JSON-safe; ağ takılırsa 3 kez dene). log/error jq İÇİNDE
# codepoint bazlı kısaltılır (controller z.string().max + servis .slice ile hizalı; tail -c
# multibyte-ortasından keserse jq'yu bozacak geçersiz UTF-8 riskini de önler) → >200KB build
# çıktısı artık finish'i 400'lemez (başarılı deploy 'stuck/failed' kalmaz).
body="$(jq -n --arg s "$status" --arg sha "$sha" --arg log "$out" --arg e "$err" \
  '{status:$s, gitSha:$sha, log:($log | if length > 20000 then .[-20000:] else . end)}
   + (if $e=="" then {} else {error:($e | if length > 4000 then .[-4000:] else . end)} end)')"
for attempt in 1 2 3; do
  if api PATCH "/v1/admin/deployments/$id/finish" "$body" >/dev/null; then
    echo "[$(date '+%F %T')] deploy-runner: $id → $status (bildirildi)"
    break
  fi
  echo "[$(date '+%F %T')] deploy-runner: finish PATCH denemesi $attempt başarısız, tekrar…"
  sleep 5
done

exit 0
