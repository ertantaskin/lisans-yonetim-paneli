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
# ── SESSİZ ARIZA KARŞITI TASARIM (denetim O1/O4) ─────────────────────────────────────────
# Bu betiğin en tehlikeli arıza biçimi ÇÖKMEK değil, HİÇBİR ŞEY YAPMAMAKTIR: yedek alınmadığı
# gün fark edilmez, ancak veri kaybı yaşandığı gün anlaşılır. Eskiden üç sessiz yol vardı:
#   (1) claim çağrısı `|| echo '{}'` ile sarılıydı → ağ hatası / 401 / API kapalı ile
#       "bekleyen iş yok" AYIRT EDİLEMİYOR, `exit 0` ediliyor ve log bile basılmıyordu;
#   (2) `--nightly` koşumu kilidi enqueue'dan ÖNCE alıyordu → 03:15'te dakikalık yoklayıcı
#       kilidi tutuyorsa gece hiç istek KAYDEDİLMEDEN çıkılıyordu (o gece yedek yok);
#   (3) enqueue hatasının TAMAMI "muhtemelen kuyrukta aktif iş var" diye raporlanıyordu →
#       401/ağ hatası yanlış teşhis ediliyordu.
# Şimdi: HTTP kodu her çağrıda okunur, 409 diğer hatalardan AYRILIR, enqueue kilitten ÖNCE ve
# yeniden denemeli yapılır, hatalar stderr'e (cron maili) düşer ve ARDIŞIK hata sayacı tutulur.
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
#   BACKUP_RUNNER_FAIL_WARN kaç ARDIŞIK API hatasından sonra büyük uyarı bloğu basılsın (vars: 5)
#
# MASTER_KEY (§8 / RUNBOOK-DR §3): yedeğin İÇİNDE DEĞİLDİR ve OLMAMALIDIR. Bu runner yalnız
# veritabanını dump eder; `.env`'e, anahtar dosyalarına ya da MASTER_KEY'e HİÇ dokunmaz ve
# offsite kancasına da yalnız dump dosyasının yolunu verir. Anahtar AYRI kasada saklanır —
# yedek tek başına ele geçse bile payload'lar çözülemez. Anahtarı yedeğin yanına koymak
# şifrelemeyi anlamsız kılar (tek dosyada tüm lisansların sızması).
#
# ÇIKIŞ KODU: 0 = yapacak iş yoktu / iş koşuldu ve sonucu panele yazıldı.
#             1 = API'ye ULAŞILAMADI ya da yapılandırma eksik (cron maili/log ile görünür).
#             Yedek işinin kendi PASS/FAIL sonucu panele yazılır (çıkış kodunu belirlemez);
#             burada 1, "runner'ın kendisi çalışamadı" demektir.
#
# Gerektirir: jq, curl (+ backup-drill.sh'ın gerektirdikleri: docker ya da psql/pg_dump).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.."   # repo kökü (/opt/lisans-yonetim-paneli)

API_BASE="${BACKUP_RUNNER_API:-${DEPLOY_RUNNER_API:-https://api.167-233-108-12.sslip.io}}"
LOCK_FILE="/tmp/wpteslimat-backup-runner.self.lock"
# ARDIŞIK API hatası sayacı: tek bir hata geçici olabilir (deploy sırasında API yeniden
# başlıyordur); KALICI hata ise yedeğin tamamen durduğu anlamına gelir ve görünmek zorundadır.
FAIL_STATE="/tmp/wpteslimat-backup-runner.apifails"
FAIL_WARN_AT="${BACKUP_RUNNER_FAIL_WARN:-5}"

log()  { printf '[%s] backup-runner: %s\n'    "$(date '+%F %T')" "$*"; }
elog() { printf '[%s] backup-runner: %s\n'    "$(date '+%F %T')" "$*" >&2; }

command -v jq >/dev/null 2>&1 || { elog "jq gerekli (apt install jq)"; exit 1; }

# .env'den anahtar okuma — `source` ETMEYİZ (MAIL_FROM gibi değerler '<'/'>' içerir ve
# sourcing bunları yönlendirme sanıp betiği patlatır; backup-drill.sh ile aynı desen).
#
# CR TEMİZLİĞİ ŞART (denetim O7): proje Windows'ta geliştiriliyor ve .env dosyası CRLF satır
# sonuyla oluşturulabiliyor. `\r` soyulmazsa token'ın SONUNA görünmez bir CR eklenir →
# `X-Admin-Token` başlığı bozulur → TÜM API çağrıları reddedilir → yedek alınmaz. Diğer dört
# betik (deploy-runner/publish-plugin/release-plugin/wp-dev) zaten `tr -d '\r"'` uyguluyordu;
# bu betik ayrışmıştı. Ayrıştırma artık onlarla AYNI.
# NOT: satır-içi yorum BİLEREK temizlenmez — parola/token '#' içerebilir ve onu kesmek sırrı
# sessizce bozardı. Sayısal ayarların yorum tolerasyonu ayrı bir sanitizer'la sağlanır.
read_env_var() { # $1=key → değer (çevresel tırnaklar + CR soyulur), eval YOK
  local key="$1" ln val
  [ -f .env ] || return 0
  ln="$(grep -E "^[[:space:]]*${key}=" .env 2>/dev/null | tail -n1 || true)"
  [ -z "$ln" ] && return 0
  val="${ln#*=}"
  val="$(printf '%s' "$val" | tr -d '\r')"
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  printf '%s' "$val"
}

# Sayısal ayar doğrulayıcı (denetim O7). `BACKUP_KEEP_LAST=14 # iki hafta` gibi bir satır
# rotasyonu SESSİZCE kapatıyordu: bash `[[ "$X" -gt 0 ]]` ifadesini aritmetik değerlendirir,
# geçersiz metinde söz dizimi hatası verip 1 döner ve `if` bunu "hayır" sayar. Değer artık
# baştaki rakam dizisine indirgenir; hiç rakam yoksa GÖRÜNÜR uyarıyla varsayılana düşer.
num_or_default() { # $1=isim $2=ham değer $3=varsayılan
  local name="$1" raw="$2" def="$3" clean
  clean="$(printf '%s' "$raw" | tr -d '[:space:]')"
  clean="${clean%%[!0-9]*}"
  if [ -z "$clean" ]; then
    [ -n "$raw" ] && elog "UYARI: $name geçersiz ('$raw') — varsayılan $def kullanılıyor."
    printf '%s' "$def"
  else
    printf '%s' "$clean"
  fi
}

ADMIN_TOKEN="${ADMIN_TOKEN:-}"
[ -z "$ADMIN_TOKEN" ] && ADMIN_TOKEN="$(read_env_var ADMIN_TOKEN)"
[ -z "$ADMIN_TOKEN" ] && { elog "ADMIN_TOKEN bulunamadı (.env) — yedek alınamaz."; exit 1; }

# Yedek ayarları: ortam > .env > varsayılan. Rotasyon VARSAYILAN OLARAK AÇIK (14) — kapalı
# bırakılırsa günlük dump'lar diski sessizce doldurur ve bir gün prod'u durdurur.
BACKUP_KEEP_LAST="$(num_or_default BACKUP_KEEP_LAST \
  "${BACKUP_KEEP_LAST:-$(read_env_var BACKUP_KEEP_LAST)}" 14)"
BACKUP_OFFSITE_CMD="${BACKUP_OFFSITE_CMD:-$(read_env_var BACKUP_OFFSITE_CMD)}"
BACKUP_OFFSITE_TIMEOUT="$(num_or_default BACKUP_OFFSITE_TIMEOUT \
  "${BACKUP_OFFSITE_TIMEOUT:-$(read_env_var BACKUP_OFFSITE_TIMEOUT)}" 900)"
BACKUP_DIR="${BACKUP_DIR:-$(read_env_var BACKUP_DIR)}"
export BACKUP_KEEP_LAST BACKUP_OFFSITE_CMD BACKUP_OFFSITE_TIMEOUT
[ -n "$BACKUP_DIR" ] && export BACKUP_DIR

# ── API yardımcısı — GÖVDE + HTTP KODU ───────────────────────────────────────────────────
# `curl -f` BİLEREK kullanılmaz: hata gövdesini de görmek ve 409'u (meşru "kuyrukta iş var")
# 401/5xx/ağ hatasından ayırmak zorundayız. Ağ/DNS hatasında kod 000 olur.
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

# Ardışık API hatası sayacı — kalıcı arıza cron logunda GÖRÜNÜR olsun.
api_fail_note(){ # $1=bağlam
  local n=0
  [ -f "$FAIL_STATE" ] && n="$(num_or_default sayac "$(cat "$FAIL_STATE" 2>/dev/null)" 0)"
  n=$((n + 1))
  printf '%s' "$n" > "$FAIL_STATE" 2>/dev/null || true
  if [ "$n" -ge "$FAIL_WARN_AT" ]; then
    elog "════════════════════════════════════════════════════════════════"
    elog "DİKKAT: panel API'sine $n ARDIŞIK başarısız çağrı ($1, son HTTP $API_HTTP)."
    elog "Bu süre boyunca YEDEK ALINMIYOR olabilir. Kontrol: ADMIN_TOKEN geçerli mi,"
    elog "API ayakta mı ($API_BASE/v1/health), .env CRLF mi? → docs/RUNBOOK-DR.md §4.3"
    elog "════════════════════════════════════════════════════════════════"
  fi
}
api_ok_note(){ [ -f "$FAIL_STATE" ] && rm -f "$FAIL_STATE" 2>/dev/null; return 0; }

# ── (Opsiyonel) KENDİ İSTEĞİNİ KUYRUĞA YAZ — gecelik/aylık otomatik koşum ────────────────
# Otomatik yedek de panelde GÖRÜNSÜN diye ayrı bir yol açılmaz: runner tam olarak operatörün
# panelden bastığı düğmenin yaptığını yapar (POST /deployments). Böylece "son yedek ne zaman"
# sorusu tek kaynaktan (deployments kuyruğu) yanıtlanır.
ENQUEUE=""
case "${1:-}" in
  --nightly)  ENQUEUE="backup" ;;
  --enqueue)  ENQUEUE="${2:-backup}" ;;
  "")         : ;;
  *)          elog "bilinmeyen argüman '${1}' (kullanım: [--nightly | --enqueue <backup|backup-drill>])"; exit 1 ;;
esac

# ENQUEUE KİLİTTEN ÖNCE (denetim O4a): kilit bu betiğin ÇALIŞTIRMA fazını korur (iki pg_dump
# üst üste binmesin). İSTEK YAZMAK ise çakışmasız ve idempotent-güvenli bir işlemdir (panel
# tarafında "aynı anda tek aktif iş" guard'ı zaten var). Eskiden enqueue kilidin ARKASINDAYDI:
# gecelik koşum, o dakikanın yoklayıcısıyla çakıştığında hiç istek yazmadan çıkıyor ve O GECE
# YEDEK ALINMIYORDU — üstelik tek satır bile log bırakmadan.
if [ -n "$ENQUEUE" ]; then
  case "$ENQUEUE" in
    backup|backup-drill) : ;;
    *) elog "geçersiz hedef '$ENQUEUE' (backup | backup-drill)"; exit 1 ;;
  esac
  req_body="$(jq -n --arg t "$ENQUEUE" '{target:$t, note:"otomatik koşum (cron)"}')"
  enq_done=0
  for attempt in 1 2 3; do
    if api POST /v1/admin/deployments "$req_body" >/dev/null; then
      log "'$ENQUEUE' isteği kuyruğa yazıldı (otomatik)"
      api_ok_note; enq_done=1; break
    fi
    case "$API_HTTP" in
      409)
        # MEŞRU durum: kuyrukta zaten aktif bir iş var (dağıtım ya da yedek). Yeniden denemek
        # anlamsız — sıradaki koşum devralır. Hata DEĞİL, bu yüzden sayaç da artmaz.
        log "istek kaydedilmedi: kuyrukta aktif iş var (HTTP 409) — sıradaki koşum devralacak"
        api_ok_note; enq_done=1; break
        ;;
      401|403)
        # Yeniden denemek DÜZELTMEZ: yetki sorunu. Hemen görünür ol.
        elog "istek kaydedilemedi: YETKİSİZ (HTTP $API_HTTP) — ADMIN_TOKEN yanlış/eskimiş olabilir."
        break
        ;;
      *)
        elog "istek kaydedilemedi (HTTP $API_HTTP), deneme $attempt/3 — 10sn sonra tekrar…"
        sleep 10
        ;;
    esac
  done
  if [ "$enq_done" != 1 ]; then
    api_fail_note "enqueue $ENQUEUE"
    elog "GECELİK/AYLIK YEDEK İSTEĞİ KAYDEDİLEMEDİ — bu koşumda yedek alınmayacak."
    exit 1
  fi
fi

# ── Tek örnek güvencesi — kilit BETİĞİN KENDİSİNE ait ────────────────────────────────────
# Dosya adı deploy-runner'ınkinden AYRI: yedek ile dağıtım birbirini bloklamasın (kuyruk zaten
# aynı anda tek aktif işe izin verir), ama İKİ yedek asla üst üste binmesin (eşzamanlı pg_dump
# = boşuna disk + CPU). `-w`: dakikalık yoklayıcı koşumları kısa sürer; kısa bir bekleme
# gereksiz atlamayı önler. Kilit yine de alınamazsa SESSİZ ÇIKMAYIZ (proje kuralı): durum
# loglanır ve iş kaybolmaz — istek kuyrukta 'pending' durur, cron bir dakika sonra tekrar dener.
exec 9>"$LOCK_FILE"
if ! flock -w 20 9; then
  log "başka bir koşum sürüyor (kilit meşgul) — iş kuyrukta kalıyor, sıradaki dakika devralacak"
  exit 0
fi

# ── 1) Bekleyen YEDEK isteğini ATOMİK al (pending→running) ───────────────────────────────
# targets filtresi ŞART: dağıtım isteklerine dokunmayız (bkz. başlık).
# HTTP kodu okunur: "yapacak iş yok" (2xx + boş gövde) ile "API'ye ulaşılamadı" ARTIK AYRI.
# DİKKAT (ÖLÇÜLDÜ, deploy-runner.sh ile aynı tuzak): `claim="$(api …)"` biçimi KULLANILMAZ.
# Komut ikamesi bir ALT KABUKTA koşar → `api()` içinde set edilen `API_HTTP` ana kabuğa DÖNMEZ
# ve aşağıdaki teşhis satırı HER ZAMAN bayat `0` basar. Çıkış kodu doğru döndüğü için alarm ve
# exit davranışı sağlamdı, ama arızanın SEBEBİ (401 = ADMIN_TOKEN eskimiş ↔ 000 = API'ye
# ulaşılamıyor) log'da ayırt edilemiyordu — yani düzeltmenin asıl senaryosu yanlış teşhis
# edilecekti. Çıktı dosyaya yönlendirilir, `api` ANA kabukta koşar.
CLAIM_OUT="/tmp/wpteslimat-backup-runner.claim.$$"
trap 'rm -f "$CLAIM_OUT"' EXIT
api POST /v1/admin/deployments/claim '{"targets":["backup","backup-drill"]}' > "$CLAIM_OUT"
claim_rc=$?
claim="$(cat "$CLAIM_OUT" 2>/dev/null || true)"
if [ "$claim_rc" -ne 0 ]; then
  elog "claim BAŞARISIZ (HTTP $API_HTTP) — bekleyen iş olup olmadığı BİLİNMİYOR."
  api_fail_note "claim"
  exit 1
fi
api_ok_note

id="$(printf '%s' "$claim" | jq -r '.id // empty' 2>/dev/null)"
[ -z "$id" ] && exit 0   # 2xx + boş gövde = gerçekten yapacak iş yok (normal, sessiz)

target="$(printf '%s' "$claim" | jq -r '.target // "backup"' 2>/dev/null)"

# ── 2) İlgili modda backup-drill.sh'ı çalıştır ───────────────────────────────────────────
if [ ! -x ./scripts/backup-drill.sh ]; then
  # Sessiz takılma yerine anlamlı hata (repo güncel mi, exec biti korunmuş mu?).
  out="backup-drill.sh bulunamadı veya çalıştırılabilir değil — repo güncel mi? (git pull)"
  code=1
elif [ "$target" = "backup-drill" ]; then
  log "claim $id → backup-drill.sh (TAM tatbikat)"
  out="$(./scripts/backup-drill.sh 2>&1)"; code=$?
else
  log "claim $id → backup-drill.sh (BACKUP_ONLY=1)"
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
  elog "yedek işi BAŞARISIZ (id=$id, target=$target): $err"
fi

# ── 3) Sonucu panele geri yaz ────────────────────────────────────────────────────────────
# log/error jq İÇİNDE codepoint bazlı kırpılır (controller z.string().max + servis .slice ile
# hizalı; `tail -c` multibyte ortasından keserse jq'yu bozacak geçersiz UTF-8 üretirdi).
# DİKKAT: panel özeti (BACKUP_FILE=/BACKUP_BYTES=/…) çıktının SONUNDA basılır ve kırpma
# SONDAN saklama yaptığı için korunur — API özeti bu satırlardan okur.
body="$(jq -n --arg s "$status" --arg sha "$sha" --arg log "$out" --arg e "$err" \
  '{status:$s, gitSha:$sha, log:($log | if length > 20000 then .[-20000:] else . end)}
   + (if $e=="" then {} else {error:($e | if length > 4000 then .[-4000:] else . end)} end)')"
reported=0
for attempt in 1 2 3; do
  if api PATCH "/v1/admin/deployments/$id/finish" "$body" >/dev/null; then
    log "$id → $status (bildirildi)"
    reported=1; api_ok_note; break
  fi
  elog "finish PATCH denemesi $attempt başarısız (HTTP $API_HTTP), tekrar…"
  sleep 5
done
if [ "$reported" != 1 ]; then
  # Sonuç panele YAZILAMADI: iş 'running' kalır ve hedefe göre (yedek 2sa / tatbikat 4sa)
  # zombi temizliğiyle kapanır. Yedek DOSYASI alınmış olabilir; panel bunu bilemez.
  elog "SONUÇ PANELE YAZILAMADI (id=$id, status=$status). Panelde iş 'running' görünecek ve"
  elog "zaman aşımıyla 'failed' olarak kapanacak — yedek dosyasını elle doğrulayın (RUNBOOK-DR §4.3)."
  api_fail_note "finish"
  exit 1
fi

exit 0
