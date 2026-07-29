#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# publish-plugin.sh — repo HEAD'indeki WP eklentisini paketleyip PANELE YAYINLAR.
#
#   ./scripts/publish-plugin.sh ["changelog metni"]
#
# Sürüm numarasına DOKUNMAZ, commit ATMAZ, push GEREKTİRMEZ. Tek işi:
# "uzağa push edilmiş HEAD'de ne varsa onu paketle → POST /v1/admin/updates/plugin".
#
# release-plugin.sh ile FARKI (ikisi bilinçli olarak ayrı betik):
#   • release-plugin.sh → GELİŞTİRİCİ MAKİNESİ: sürümü sed'ler (wpteslimat.php + readme.txt),
#     yayın commit'i atar, paketler, yayınlar. `git push` sonrasında SEN yaparsın.
#   • publish-plugin.sh → VPS/PROD (panelden "Kaynaktan yayınla" → deploy-runner.sh):
#     yalnız YAYINLAR. Sürüm artırımı zaten geliştirici makinesinde commit'lenip push edilmiştir.
#
# NEDEN VPS'te commit/push YAPILMIYOR (ölçüldü, varsayım değil):
#   • prod checkout'unda `git config user.email` / `user.name` TANIMLI DEĞİL → `git commit` düşer,
#   • remote HTTPS GitHub ve kimlik bilgisi yok → `git push` "could not read Username" ile düşer,
#   • dahası: prod checkout'unda YEREL commit üretmek repoyu origin'den AYIRIR ve bir sonraki
#     `deploy.sh`'ın `git pull --ff-only` adımını KALICI olarak kırar (dağıtım kilitlenir).
#   Bu yüzden release-plugin.sh VPS'te çalıştırılamaz; onun VPS'teki karşılığı bu betiktir.
#
# Ortam: PANEL_API (varsayılan prod), ADMIN_TOKEN (ortamdan ya da repo kökündeki .env'den).
# Gerektirir: git, jq, curl, base64. (Harici `zip` binary'si VPS'te YOK → git archive kullanılır.)
#
# Not: aşağıdaki `git pull` bu betiğin KENDİSİNİ de güncelleyebilir; git yeni içeriği ayrı bir
# inode'a yazdığından (unlink+create) koşmakta olan kabuk eski dosyayı okumaya devam eder →
# çalışan yayın bozulmaz, yeni sürüm SONRAKİ koşuda geçerli olur.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.." || { echo "publish-plugin: repo köküne geçilemedi." >&2; exit 1; }

CHANGELOG_ARG="${1:-}"
PANEL_API="${PANEL_API:-https://api.167-233-108-12.sslip.io}"
PLUGIN_DIR="apps/wp-plugin/wpteslimat"

# Renkler YALNIZ gerçek TTY'de (deploy.sh deseni). Runner çıktıyı $(...) ile yakalayıp panele
# yazıyor → ham \033[..m escape kodları DB log alanına ve /deployments ekranına sızmasın.
if [ -t 1 ]; then
  C_SAY=$'\033[1;36m'; C_OK=$'\033[1;32m'; C_ERR=$'\033[1;31m'; C_RST=$'\033[0m'
else
  C_SAY=''; C_OK=''; C_ERR=''; C_RST=''
fi
say(){ printf '\n%s▸ %s%s\n' "$C_SAY" "$*" "$C_RST"; }
ok(){  printf '%s✓ %s%s\n' "$C_OK" "$*" "$C_RST"; }
err(){ printf '%s✗ %s%s\n' "$C_ERR" "$*" "$C_RST" >&2; }

# Geçici dosyalar: her çıkış yolunda (hata dahil) temizlenir — base64 gövde ~MB'lar.
ZIP=""; B64=""; BODY=""; RESP=""
cleanup(){
  [ -n "$ZIP" ]  && rm -f "$ZIP"
  [ -n "$B64" ]  && rm -f "$B64"
  [ -n "$BODY" ] && rm -f "$BODY"
  [ -n "$RESP" ] && rm -f "$RESP"
  return 0
}
trap cleanup EXIT

# 0) Ön koşullar. jq zorunlu: changelog metni çok satırlı/tırnaklı olabilir; JSON'u elle
#    kaçışlamak (sed) bu metinlerde gövdeyi bozar → jq ile kurulur.
command -v jq   >/dev/null 2>&1 || { err "jq gerekli (apt install jq) — istek gövdesi jq ile kurulur."; exit 1; }
command -v curl >/dev/null 2>&1 || { err "curl gerekli — panele yayın yapılamaz."; exit 1; }

ADMIN_TOKEN="${ADMIN_TOKEN:-}"
if [ -z "$ADMIN_TOKEN" ] && [ -f .env ]; then
  ADMIN_TOKEN="$(grep -E '^ADMIN_TOKEN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r"')"
fi
[ -n "$ADMIN_TOKEN" ] || { err "ADMIN_TOKEN bulunamadı (ortam ya da repo kökündeki .env) — panele yayınlanamaz."; exit 1; }

# 1a) Detached HEAD kontrolü. deploy.sh başarısız bir dağıtımı geri alırken repoyu (eskiden)
#     detached bırakabiliyordu; o durumda HEAD, uzağa push edilmiş SON kod DEĞİL geri alınmış
#     ESKİ koddur. Buradan paketlemek eski eklentiyi "yeni sürüm" diye dağıtmak olurdu.
#     Bilinçli olarak SELF-HEAL YAPMIYORUZ (deploy.sh'ın işi): checkout etmek prod çalışma
#     ağacını, koşan konteynerlerin build'inden farklı bir commit'e taşırdı.
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  err "Repo bir dala bağlı değil (detached HEAD) — yayın durduruldu."
  err "Muhtemelen başarısız bir panel dağıtımının geri alması yürürlükte; HEAD eski kodu gösteriyor."
  err "Önce panel dağıtımını düzeltin (deploy.sh dala geri döner), sonra yayını tekrar tetikleyin."
  exit 1
fi

# 1b) Uzak dal ile eşitle. Amaç "en son PUSH EDİLMİŞ kodu yayınlamak" olduğundan, pull
#     başarısızsa DURURUZ: eşitlenememiş checkout'tan yayın yapmak ESKİ (ya da ayrışmış)
#     kodu "yeni sürüm" diye müşteri sitelerine dağıtmak olurdu.
say "Uzak dal ile eşitleniyor ($BRANCH · git pull --ff-only)…"
PULL_OUT="$(git pull --ff-only 2>&1)"
if [ $? -ne 0 ]; then
  err "git pull --ff-only BAŞARISIZ — yayın durduruldu."
  printf '%s\n' "$PULL_OUT" >&2
  err "Olası sebep: yerel commit yüzünden uzak dal ile AYRIŞMA (prod checkout'unda commit"
  err "ATILMAMALI), ağ/erişim hatası ya da çalışma ağacındaki değişikliğin pull ile çakışması."
  exit 1
fi
printf '%s\n' "$PULL_OUT"
ok "Repo güncel — HEAD: $(git rev-parse --short HEAD 2>/dev/null || echo '?')"

# 2) TEMİZLİK KONTROLÜ — paketleme HEAD'den yapılır (git archive).
#    --untracked-files=all: `git add` edilmemiş yeni PHP dosyaları da tek tek görünsün; onlar da
#    zip'e GİRMEZ. Kirli ağaçtan yayın "yayınlandı" der ama müşteri siteleri HEAD'deki (farklı)
#    kodu çeker → sessiz yanlış yayın; hata da vermez. Bu yüzden kirliyse DURURUZ.
DIRTY="$(git status --porcelain --untracked-files=all -- "$PLUGIN_DIR" 2>/dev/null)"
if [ -n "$DIRTY" ]; then
  err "Eklenti dizininde ($PLUGIN_DIR) commit EDİLMEMİŞ değişiklik var — yayın durduruldu."
  err "Paketleme 'git archive HEAD' ile yapılır; aşağıdaki değişiklikler zip'e GİRMEZ:"
  printf '%s\n' "$DIRTY" >&2
  err "Bu değişiklikleri GELİŞTİRİCİ MAKİNESİNDE commit'leyip push edin (prod checkout'unda"
  err "commit atmayın), sonra yayını tekrar tetikleyin."
  exit 1
fi
ok "Eklenti dizini temiz — HEAD, paketlenecek içerikle birebir aynı."

# 3) Sürümü HEAD'DEN oku (çalışma ağacından DEĞİL — paketlenen içerik HEAD'dir).
#    Başlık ('Version:') ile sabit (WPTESLIMAT_VERSION) BİRBİRİYLE aynı olmalı: eklenti
#    güncelleyicisi sabiti, panel/WP listesi başlığı okur — ayrışırsa siteler sonsuz
#    "güncelleme var" gösterir ya da hiç güncellemez.
HEAD_SRC="$(git show "HEAD:$PLUGIN_DIR/wpteslimat.php" 2>/dev/null)"
if [ -z "$HEAD_SRC" ]; then
  err "HEAD'de $PLUGIN_DIR/wpteslimat.php okunamadı — eklenti ana dosyası yok ya da yolu değişmiş."
  exit 1
fi
HEAD_VER="$(printf '%s\n' "$HEAD_SRC" | { grep -m1 'Version:' || true; } \
  | sed -E 's/.*Version:[[:space:]]*//' | tr -d '\r')"
HEAD_CONST="$(printf '%s\n' "$HEAD_SRC" | { grep -m1 'WPTESLIMAT_VERSION' || true; } \
  | sed -E "s/.*WPTESLIMAT_VERSION',[[:space:]]*'([^']*)'.*/\1/" | tr -d '\r')"

if [ -z "$HEAD_VER" ] || [ -z "$HEAD_CONST" ]; then
  err "HEAD'deki eklenti sürümü okunamadı (başlık='$HEAD_VER', sabit='$HEAD_CONST')."
  err "wpteslimat.php içinde ' * Version: X.Y.Z' başlığı ve WPTESLIMAT_VERSION sabiti olmalı."
  exit 1
fi
if [ "$HEAD_VER" != "$HEAD_CONST" ]; then
  err "HEAD'de sürüm TUTARSIZ: başlık='$HEAD_VER' ≠ WPTESLIMAT_VERSION='$HEAD_CONST'."
  err "Sürüm artırımı eksik commit'lenmiş olabilir — geliştirici makinesinde düzeltip push edin."
  exit 1
fi
VER="$HEAD_VER"
printf '%s' "$VER" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || {
  err "HEAD'deki sürüm SemVer değil: '$VER' (beklenen biçim: X.Y.Z)."
  err "Panel en son sürümü semver'e göre seçer; geçersiz biçim daima 'en düşük' sayılır →"
  err "yayınlansa bile müşteri siteleri bu sürümü ASLA güncelleme olarak görmez."
  exit 1
}
CHANGELOG_TEXT="${CHANGELOG_ARG:-Sürüm $VER}"
ok "HEAD sürümü: v$VER (başlık + WPTESLIMAT_VERSION sabiti tutarlı)."

# 4) Paketle — git archive (harici `zip` binary'si VPS'te YOK).
#    prefix=wpteslimat/ → WP eklentiyi doğru klasöre açar.
say "Paketleniyor: HEAD:$PLUGIN_DIR → wpteslimat/ (v$VER)"
ZIP="$(mktemp -u).zip"
git archive --format=zip --prefix=wpteslimat/ -o "$ZIP" "HEAD:$PLUGIN_DIR" || {
  err "git archive BAŞARISIZ — paket üretilemedi (HEAD'de $PLUGIN_DIR var mı?)."
  exit 1
}
SIZE="$(wc -c < "$ZIP" 2>/dev/null | tr -d ' ')"
[ -n "$SIZE" ] && [ "$SIZE" -gt 0 ] 2>/dev/null || {
  err "Üretilen paket BOŞ — yayın durduruldu (bozuk zip müşteri sitelerini kırardı)."
  exit 1
}
ok "Paketlendi: $SIZE bayt"

# 5) Gövdeyi kur ve yayınla. Büyük base64 → dosyadan gönderilir (argüman uzunluk limiti yok);
#    JSON jq ile kurulur (--rawfile ile base64 dosyası okunur) → çok satırlı/tırnaklı changelog
#    metni gövdeyi BOZAMAZ (elle sed kaçışının aksine).
B64="$(mktemp)"
base64 < "$ZIP" | tr -d '\n' > "$B64" || { err "base64 kodlaması BAŞARISIZ."; exit 1; }
BODY="$(mktemp)"
jq -n --arg v "$VER" --arg cl "$CHANGELOG_TEXT" --rawfile zip "$B64" \
  '{version:$v, changelog:$cl, zipB64:($zip | rtrimstr("\n"))}' > "$BODY" || {
  err "İstek gövdesi (JSON) kurulamadı — jq hatası."
  exit 1
}

say "Panele yayınlanıyor: $PANEL_API/v1/admin/updates/plugin"
RESP="$(mktemp)"
CODE="$(curl -s -o "$RESP" -w '%{http_code}' --max-time 120 -X POST \
  "$PANEL_API/v1/admin/updates/plugin" \
  -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data-binary "@$BODY")" || CODE="000"

if [ "$CODE" = "201" ] || [ "$CODE" = "200" ]; then
  ok "Yayınlandı: v$VER (HTTP $CODE). $(head -c 400 "$RESP" 2>/dev/null)"
  say "Panelde Sürümler (/releases) listesinde görünür; müşteri siteleri güncelleyebilir."
  exit 0
fi

err "Yayın BAŞARISIZ (HTTP $CODE) — v$VER panele gitmedi."
printf '%s\n' "$(head -c 800 "$RESP" 2>/dev/null)" >&2
if [ "$CODE" = "000" ]; then
  err "Panele hiç ulaşılamadı (ağ/TLS/zaman aşımı) — PANEL_API='$PANEL_API' erişilebilir mi?"
elif [ "$CODE" = "401" ] || [ "$CODE" = "403" ]; then
  err "Yetki reddedildi — ADMIN_TOKEN geçerli mi (.env ile API'nin değeri aynı mı)?"
elif [ "$CODE" = "413" ]; then
  err "Paket gövde sınırını aştı — API bodyLimit ayarını kontrol edin."
fi
exit 1
