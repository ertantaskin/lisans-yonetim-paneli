#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-runner.sh — VPS HOST'unda çalışan dağıtım işçisi (§16). Panelden gelen
# "Prod'a dağıt" isteklerini işler: bekleyen isteği alır → `deploy.sh`'ı çalıştırır →
# sonucu panele geri yazar. Panel konteynerine Docker soketi VERİLMEZ (güvenlik:
# konteynerden host'a tam erişim demek olurdu) — bu ayrım tam da bu yüzden.
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
# Gerektirir: jq, curl, git, docker (deploy.sh için). ADMIN_TOKEN repo kökündeki .env'den okunur.
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
claim="$(api POST /v1/admin/deployments/claim || echo '{}')"
id="$(printf '%s' "$claim" | jq -r '.id // empty' 2>/dev/null)"
[ -z "$id" ] && exit 0

target="$(printf '%s' "$claim" | jq -r '.target // "api admin"' 2>/dev/null)"
echo "[$(date '+%F %T')] deploy-runner: claim $id → deploy.sh $target"

# 2) deploy.sh'ı çalıştır (çıktıyı yakala; deploy.sh kendi rollback'ini yapar).
out="$(./scripts/deploy.sh $target 2>&1)"; code=$?
# Kalan ANSI escape kodlarını soy (deploy.sh TTY'siz zaten renk basmaz — çift savunma).
out="$(printf '%s' "$out" | sed -E 's/\x1b\[[0-9;]*m//g')"
sha="$(git rev-parse --short HEAD 2>/dev/null || echo '')"
status="success"; err=""
if [ "$code" -ne 0 ]; then
  status="failed"
  err="$(printf '%s' "$out" | grep -E '✗|BAŞARISIZ|FAIL' | tail -1)"
  [ -z "$err" ] && err="deploy.sh çıkış kodu $code"
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
