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
# ── SESSİZ ARIZA KARŞITI TASARIM (backup-runner.sh ile aynı desen) ──────────────────────────
# Bu betiğin en tehlikeli arıza biçimi ÇÖKMEK değil, HİÇBİR ŞEY YAPMAMAKTIR. Eskiden claim
# çağrısı `curl -fsS ... || echo '{}'` ile sarılıydı: 401 / 5xx / ağ hatası ile "bekleyen iş
# yok" AYIRT EDİLEMİYOR ve betik tek satır log bile basmadan `exit 0` ediyordu. ADMIN_TOKEN
# rotasyonundan sonra .env güncellenmezse panelden basılan "Prod'a dağıt" isteği HİÇ claim
# edilmez, sonsuza dek 'pending'de bekler ve teşhis izi kalmaz. Artık her çağrıda HTTP kodu
# okunur; "iş yok" (2xx + boş gövde) SESSİZ, her hata GÖRÜNÜR ve sıfırdan farklı çıkış kodludur.
#
# ÇIKIŞ KODU: 0 = yapacak iş yoktu / iş koşuldu ve sonucu panele yazıldı.
#             1 = API'ye ULAŞILAMADI, yetki reddedildi ya da sonuç panele yazılamadı
#                 (cron maili/log ile görünür). Dağıtımın kendi PASS/FAIL sonucu panele yazılır
#                 ve çıkış kodunu belirlemez; buradaki 1 "runner'ın kendisi çalışamadı" demektir.
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
if ! flock -n 9; then
  # LOGLA, sessizce çıkma. Uzun süren bir dağıtım boyunca atlanan her dakikalık koşumun izi
  # kalmalı; aksi halde "cron çalışıyor mu, yoksa takılı bir kilit mi var?" sorusu logdan
  # yanıtlanamaz. Kardeş `backup-runner.sh` bunu zaten yapıyordu — asimetri kapatıldı.
  echo "$(date '+%F %T') deploy-runner: başka bir koşum sürüyor (kilit meşgul), atlandı."
  exit 0
fi

command -v jq >/dev/null 2>&1 || { echo "deploy-runner: jq gerekli (apt install jq)"; exit 1; }

# ADMIN_TOKEN: ortamdan ya da .env'den.
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
if [ -z "$ADMIN_TOKEN" ] && [ -f .env ]; then
  ADMIN_TOKEN="$(grep -E '^ADMIN_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d '\r"' )"
fi
[ -z "$ADMIN_TOKEN" ] && { echo "deploy-runner: ADMIN_TOKEN bulunamadı (.env)"; exit 1; }

log()  { printf '[%s] deploy-runner: %s\n' "$(date '+%F %T')" "$*"; }
elog() { printf '[%s] deploy-runner: %s\n' "$(date '+%F %T')" "$*" >&2; }

# ── API yardımcısı — GÖVDE + HTTP KODU (backup-runner.sh ile BİREBİR aynı desen) ────────────
# `curl -f` BİLEREK kullanılmaz: eskiden çağrı `-fsS ... || echo '{}'` biçimindeydi ve bu,
# "yapacak iş yok" (2xx + boş gövde) ile "API'ye ULAŞILAMADI / 401 / 5xx" durumlarını AYNI
# şeye indirgiyordu → betik TEK SATIR LOG BİLE BASMADAN `exit 0` ediyordu. SESSİZ ARIZA:
# ADMIN_TOKEN rotasyonundan sonra .env güncellenmezse panelden basılan "Prod'a dağıt" isteği
# HİÇ claim edilmez, istek sonsuza dek 'pending'de bekler ve cron logunda hiçbir teşhis izi
# kalmaz. Artık HTTP kodu okunur ve hata TÜRÜNE göre ayrı raporlanır. Ağ/DNS hatasında kod 000.
API_HTTP=0
api(){  # api METHOD PATH [json-body]  → gövdeyi stdout'a basar, kodu $API_HTTP'ye yazar
  local method="$1" path="$2" body="${3:-}" resp=""
  if [ -n "$body" ]; then
    resp="$(curl -sS --max-time 20 -X "$method" \
      -H "X-Admin-Token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
      -d "$body" -w $'\n%{http_code}' "$API_BASE$path" 2>/dev/null)"
  else
    resp="$(curl -sS --max-time 20 -X "$method" \
      -H "X-Admin-Token: $ADMIN_TOKEN" -w $'\n%{http_code}' "$API_BASE$path" 2>/dev/null)"
  fi
  if [ -z "$resp" ]; then API_HTTP="000"; return 1; fi
  API_HTTP="${resp##*$'\n'}"
  printf '%s' "${resp%$'\n'*}"
  case "$API_HTTP" in 2??) return 0 ;; *) return 1 ;; esac
}

# 1) Bekleyen isteği ATOMİK al (pending→running).
# `targets` filtresi ŞART: aynı kuyruğu `backup-runner.sh` de yokluyor (yedek/tatbikat
# hedefleri). Filtre olmasaydı bu runner bir 'backup' isteğini kapıp `deploy.sh backup`
# çalıştırmaya kalkardı; claim geri alınamadığı için istek boşa harcanır ve yedek hiç
# alınmazdı. Alan API'de OPSİYONEL → eski panel sürümüyle de uyumlu (tüm hedefler).
#
# DİKKAT (ÖLÇÜLDÜ): `claim="$(api …)"` biçimi KULLANILMAZ. Komut ikamesi bir ALT KABUKTA koşar →
# `api()` içinde set edilen `API_HTTP` ana kabuğa DÖNMEZ ve hata mesajı her zaman başlangıç
# değerini basar; 401/403 dalı da hiç çalışmazdı (yani ADMIN_TOKEN rotasyonu — bu düzeltmenin
# ASIL senaryosu — yanlış teşhis edilirdi). Çıkış KODU alt kabuktan doğru döner, HTTP kodu dönmez.
# Bu yüzden çağrı gövdesi dosyaya yönlendirilir: `api` ANA KABUKTA koşar, iki bilgi de korunur.
CLAIM_OUT="/tmp/wpteslimat-deploy-runner.claim.$$"
api POST /v1/admin/deployments/claim '{"targets":["api","admin","api admin","plugin"]}' > "$CLAIM_OUT"
claim_rc=$?
claim="$(cat "$CLAIM_OUT" 2>/dev/null)"
rm -f "$CLAIM_OUT"
if [ "$claim_rc" -ne 0 ]; then
  # "İş yok" DEĞİL: claim'in kendisi başarısız oldu. Bekleyen dağıtım olup olmadığı BİLİNMİYOR.
  elog "claim BAŞARISIZ (HTTP $API_HTTP) — bekleyen dağıtım isteği olup olmadığı BİLİNMİYOR."
  case "$API_HTTP" in
    401|403) elog "YETKİSİZ: ADMIN_TOKEN yanlış/eskimiş olabilir (rotasyondan sonra .env güncellendi mi?)." ;;
    000)     elog "API'ye ULAŞILAMADI ($API_BASE) — servis ayakta mı, ağ/DNS sorunu var mı?" ;;
    *)       elog "Beklenmeyen yanıt — API logunu kontrol edin ($API_BASE/v1/health)." ;;
  esac
  exit 1
fi

id="$(printf '%s' "$claim" | jq -r '.id // empty' 2>/dev/null)"
# 2xx + boş gövde = gerçekten yapacak iş yok. NORMAL durum → sessiz çıkış (dakikada bir koşuyor,
# log kirletmemeli). Sessizlik yalnız BURADA meşrudur: yukarıda hata olmadığı KANITLANDI.
[ -z "$id" ] && exit 0

target="$(printf '%s' "$claim" | jq -r '.target // "api admin"' 2>/dev/null)"
# `note` yalnız eklenti yayınında anlamlı (changelog metni). Alan yoksa boş kalır →
# publish-plugin.sh varsayılan metne ("Sürüm <VER>") düşer; eski API ile de uyumlu.
note="$(printf '%s' "$claim" | jq -r '.note // empty' 2>/dev/null)"

# 2) Hedefe göre ilgili betiği çalıştır (çıktıyı yakala; betikler kendi hatalarını raporlar).
runner_script="deploy.sh"
if [ "$target" = "plugin" ]; then
  runner_script="publish-plugin.sh"
  log "claim $id → publish-plugin.sh (eklenti yayını)"
  if [ ! -x ./scripts/publish-plugin.sh ]; then
    # Panel bu hedefi sunuyor ama betik prod checkout'unda yok/çalıştırılabilir değil →
    # sessiz takılma yerine anlamlı hata (repo güncel mi, exec biti korunmuş mu?).
    out="publish-plugin.sh bulunamadı veya çalıştırılabilir değil — repo güncel mi? (git pull)"
    code=1
  else
    out="$(./scripts/publish-plugin.sh "$note" 2>&1)"; code=$?
  fi
else
  log "claim $id → deploy.sh $target"
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
  elog "iş BAŞARISIZ (id=$id, target=$target): $err"
fi

# 3) Sonucu panele geri yaz (jq ile JSON-safe; ağ takılırsa 3 kez dene). log/error jq İÇİNDE
# codepoint bazlı kısaltılır (controller z.string().max + servis .slice ile hizalı; tail -c
# multibyte-ortasından keserse jq'yu bozacak geçersiz UTF-8 riskini de önler) → >200KB build
# çıktısı artık finish'i 400'lemez (başarılı deploy 'stuck/failed' kalmaz).
body="$(jq -n --arg s "$status" --arg sha "$sha" --arg log "$out" --arg e "$err" \
  '{status:$s, gitSha:$sha, log:($log | if length > 20000 then .[-20000:] else . end)}
   + (if $e=="" then {} else {error:($e | if length > 4000 then .[-4000:] else . end)} end)')"
reported=0
for attempt in 1 2 3; do
  if api PATCH "/v1/admin/deployments/$id/finish" "$body" >/dev/null; then
    log "$id → $status (bildirildi)"
    reported=1; break
  fi
  elog "finish PATCH denemesi $attempt başarısız (HTTP $API_HTTP), tekrar…"
  sleep 5
done
if [ "$reported" != 1 ]; then
  # Sonuç panele YAZILAMADI: iş 'running' kalır ve server-side zombi temizliğiyle 'failed'
  # olarak kapanır. Dağıtım GERÇEKTE başarılı olmuş olabilir; panel bunu bilemez → operatörün
  # /v1/health ile elle doğrulaması gerekir. Sessiz çıkış BURADA da yasak.
  elog "SONUÇ PANELE YAZILAMADI (id=$id, status=$status, HTTP $API_HTTP). Panelde iş 'running'"
  elog "görünecek ve zaman aşımıyla 'failed' kapanacak — canlı sürümü elle doğrulayın."
  exit 1
fi

exit 0
