#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# release-plugin.sh — WP eklentisinin yeni sürümünü çıkarır ve panele yayınlar
# (müşteri siteleri kendi güncelleyicisiyle çeker).
#
#   ./scripts/release-plugin.sh <sürüm> ["changelog metni"]
#   örn:  ./scripts/release-plugin.sh 0.2.0 "Klon guard düzeltmesi + marka güncellemesi"
#
# Yapar: eklenti dizininin TEMİZ olduğunu doğrular → sürümü wpteslimat.php + readme.txt'de
#        günceller → yayın commit'i atar → temiz .zip paketler (git archive) → panele
#        POST /v1/admin/updates/plugin.
#
# ÖN KOŞUL: eklenti dizininde commit edilmemiş/izlenmeyen değişiklik OLMAMALI — paketleme
#           HEAD'den yapılır, çalışma ağacındaki kod zip'e GİRMEZ.
#
# Ortam: PANEL_API (varsayılan prod), ADMIN_TOKEN (.env'den). git push'u SEN yaparsın.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${1:-}"
CHANGELOG_TEXT="${2:-Sürüm $VER}"
PANEL_API="${PANEL_API:-https://api.167-233-108-12.sslip.io}"
PLUGIN_DIR="apps/wp-plugin/wpteslimat"

say(){ printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok(){  printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
err(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }

[ -n "$VER" ] || { err "Kullanım: ./scripts/release-plugin.sh <sürüm> [\"changelog\"]"; exit 1; }
echo "$VER" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || { err "Sürüm SemVer olmalı (ör. 0.2.0)."; exit 1; }
ADMIN_TOKEN="$(grep -E '^ADMIN_TOKEN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r"' || true)"
[ -n "$ADMIN_TOKEN" ] || { err "ADMIN_TOKEN .env'de bulunamadı — panele yayınlanamaz."; exit 1; }

# Mevcut sürüm başlıktan okunur. Başlık biçimi kayarsa (grep boş) `set -e` betiği SESSİZCE
# düşürüyordu (çıkış 1, tek satır mesaj yok) — sebebi söyleyerek dur: aşağıdaki sed'ler de
# aynı biçime dayanır, yani sürüm dosyaları güncellenmeden yayın denemesi anlamsızdır.
CUR="$({ grep -m1 'Version:' "$PLUGIN_DIR/wpteslimat.php" || true; } | sed -E 's/.*Version:[[:space:]]*//' | tr -d '\r')"
[ -n "$CUR" ] || {
  err "$PLUGIN_DIR/wpteslimat.php içinde eklenti başlığı 'Version:' satırı bulunamadı."
  err "Sürüm güncelleme sed'leri bu biçime dayanır — yayın durduruldu."
  exit 1
}
say "Eklenti sürümü: $CUR → $VER"

# Eklenti dizinindeki commit EDİLMEMİŞ (izlenmeyen dahil) değişiklikleri listeler.
# --untracked-files=all: yeni eklenmiş ama `git add` edilmemiş PHP dosyalarını da tek tek
# gösterir — bunlar da `git archive HEAD` paketine GİRMEZ.
plugin_dirty(){ git status --porcelain --untracked-files=all -- "$PLUGIN_DIR"; }

# 0) TEMİZLİK KONTROLÜ — paketleme HEAD'den yapılır.
#    Adım 2b yalnız "HEAD beyan edilen SÜRÜMÜ taşıyor mu" diye bakar; bu kontrol tek başına
#    YANLIŞ GÜVEN verir: sürüm satırı doğru olsa bile eklentideki commit'lenmemiş KOD
#    değişiklikleri zip'e girmez → "v$VER yayınlandı" denir ama müşteri siteleri ESKİ kodu
#    çeker (sessiz yanlış yayın; hata da vermez, çünkü sürüm numarası tutar).
DIRTY="$(plugin_dirty)"
if [ -n "$DIRTY" ]; then
  err "Eklenti dizininde COMMIT EDİLMEMİŞ değişiklik var — yayın durduruldu."
  err "Paketleme 'git archive HEAD' ile yapılır; aşağıdaki değişiklikler zip'e GİRMEZ,"
  err "yani v$VER ESKİ koddan üretilmiş olurdu:"
  printf '%s\n' "$DIRTY" >&2
  err "Önce bu değişiklikleri commit edin (ya da 'git checkout -- $PLUGIN_DIR' ile geri alın),"
  err "sonra tekrar deneyin. (Önceki başarısız denemenin bıraktığı sürüm sed'leri de burada görünür.)"
  exit 1
fi
ok "Eklenti dizini temiz — HEAD paketlenecek içerikle birebir aynı."

# 1) Sürüm numaralarını güncelle (görünen başlık + sabit + readme).
sed -i -E "s/^( \* Version:[[:space:]]*).*/\1$VER/" "$PLUGIN_DIR/wpteslimat.php"
sed -i -E "s/(define\('WPTESLIMAT_VERSION', ')[^']*('\);)/\1$VER\2/" "$PLUGIN_DIR/wpteslimat.php"
sed -i -E "s/^(Stable tag:[[:space:]]*).*/\1$VER/" "$PLUGIN_DIR/readme.txt"
ok "Sürüm dosyaları güncellendi."

# 2) Yayın commit'i (yalnız bu iki dosya — başka staged değişikliği etkilemez).
#    KRİTİK: paketleme (adım 3) HEAD'den yapılır. Commit başarısız olup hata YUTULURSA
#    zip ESKİ koddan üretilir ama YENİ sürüm numarasıyla yayınlanır (sessiz yanlış yayın:
#    müşteri siteleri "v$VER" görüp güncelledi sanır, içerik eski). Bu yüzden:
#      - commit edilecek bir değişiklik VARSA commit BAŞARILI olmak ZORUNDA (yoksa exit 1),
#      - hiç değişiklik yoksa (aynı sürüm yeniden yayınlanıyor) commit atlanır; doğruluğu
#        adım 2b'deki HEAD sürüm kontrolü garanti eder.
if git diff --quiet HEAD -- "$PLUGIN_DIR/wpteslimat.php" "$PLUGIN_DIR/readme.txt"; then
  say "Sürüm dosyaları HEAD ile aynı — yeni commit gerekmiyor (yeniden yayın)."
else
  git commit "$PLUGIN_DIR/wpteslimat.php" "$PLUGIN_DIR/readme.txt" \
    -m "release(plugin): v$VER" >/dev/null 2>&1 || {
      err "Yayın commit'i BAŞARISIZ — paketleme HEAD'den yapıldığı için ESKİ kod v$VER olarak"
      err "yayınlanırdı. Sürüm dosyalarındaki değişikliği elle commit edip tekrar deneyin"
      err "(ör. kilitli index, pre-commit hook, kimlik ayarı eksik: git config user.email)."
      exit 1
    }
  ok "Yayın commit'i atıldı: release(plugin): v$VER"
fi

# 2b) HEAD gerçekten v$VER'i taşıyor mu? (Paketleme HEAD'den; sed/commit yolunda bir şey
#     kaydıysa burada DURURUZ — yanlış içerikli sürüm ASLA yayınlanmaz.)
HEAD_SRC="$(git show "HEAD:$PLUGIN_DIR/wpteslimat.php")"
HEAD_VER="$(printf '%s\n' "$HEAD_SRC" | { grep -m1 'Version:' || true; } \
  | sed -E 's/.*Version:[[:space:]]*//' | tr -d '\r')"
HEAD_CONST="$(printf '%s\n' "$HEAD_SRC" | { grep -m1 "WPTESLIMAT_VERSION" || true; } \
  | sed -E "s/.*WPTESLIMAT_VERSION',[[:space:]]*'([^']*)'.*/\1/" | tr -d '\r')"
if [ "$HEAD_VER" != "$VER" ] || [ "$HEAD_CONST" != "$VER" ]; then
  err "HEAD beyan edilen sürümü taşımıyor (başlık='$HEAD_VER', sabit='$HEAD_CONST', beklenen='$VER')."
  err "Paketleme HEAD'den yapılır → yayınlanacak zip v$VER içeriği OLMAZDI. Yayın durduruldu."
  exit 1
fi
ok "HEAD sürüm doğrulaması: v$VER (başlık + WPTESLIMAT_VERSION sabiti)."

# 2c) Paketleme ANINDA son savunma: sed+commit sonrası eklenti dizini yine temiz olmalı.
#     (Adım 0'dan sonra dosya değiştiyse — eşzamanlı düzenleme, kısmi commit, hook — HEAD ile
#      çalışma ağacı ayrışmıştır ve zip beklenen içeriği taşımaz.)
DIRTY_AT_PACK="$(plugin_dirty)"
if [ -n "$DIRTY_AT_PACK" ]; then
  err "Paketleme öncesi eklenti dizini yine kirli — HEAD ile çalışma ağacı ayrıştı:"
  printf '%s\n' "$DIRTY_AT_PACK" >&2
  err "Yayın durduruldu (zip beklenen içeriği taşımazdı)."
  exit 1
fi

# 3) Temiz .zip paketle — git archive ile (harici 'zip' binary'sine gerek yok).
#    prefix=wpteslimat/ → WP doğru klasöre açar. Sadece commit'li içerik paketlenir.
ZIP="$(mktemp -u).zip"
git archive --format=zip --prefix=wpteslimat/ -o "$ZIP" "HEAD:$PLUGIN_DIR"
ok "Paketlendi: $(wc -c < "$ZIP") bayt"

# 4) Panele yayınla. Büyük base64 gövde → dosyadan gönder (arg limiti yok).
B64="$(mktemp)"; base64 < "$ZIP" | tr -d '\n' > "$B64"
CL="$(printf '%s' "$CHANGELOG_TEXT" | sed 's/\\/\\\\/g; s/"/\\"/g')"
BODY="$(mktemp)"
{ printf '{"version":"%s","changelog":"%s","zipB64":"' "$VER" "$CL"; cat "$B64"; printf '"}'; } > "$BODY"

say "Panele yayınlanıyor: $PANEL_API/v1/admin/updates/plugin"
CODE="$(curl -s -o /tmp/rel-resp.json -w '%{http_code}' -X POST "$PANEL_API/v1/admin/updates/plugin" \
  -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' --data-binary "@$BODY")"
rm -f "$ZIP" "$B64" "$BODY"

if [ "$CODE" = "201" ] || [ "$CODE" = "200" ]; then
  ok "Yayınlandı: v$VER (HTTP $CODE). $(cat /tmp/rel-resp.json)"
  say "Şimdi:  git push origin main   (yayın commit'ini uzağa gönder)"
  say "Panelde Sürümler (/releases) listesinde görünür; müşteri siteleri güncelleyebilir."
else
  err "Yayın başarısız (HTTP $CODE): $(cat /tmp/rel-resp.json)"
  err "Sürüm commit'i atıldı ama panele gitmedi — panel erişimini/ADMIN_TOKEN'ı kontrol et."
  exit 1
fi
