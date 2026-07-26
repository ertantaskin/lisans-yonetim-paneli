#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# release-plugin.sh — WP eklentisinin yeni sürümünü çıkarır ve panele yayınlar
# (müşteri siteleri kendi güncelleyicisiyle çeker).
#
#   ./scripts/release-plugin.sh <sürüm> ["changelog metni"]
#   örn:  ./scripts/release-plugin.sh 0.2.0 "Klon guard düzeltmesi + marka güncellemesi"
#
# Yapar: sürümü jetlisans.php + readme.txt'de günceller → yayın commit'i atar →
#        temiz .zip paketler (git archive) → panele POST /v1/admin/updates/plugin.
#
# Ortam: PANEL_API (varsayılan prod), ADMIN_TOKEN (.env'den). git push'u SEN yaparsın.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${1:-}"
CHANGELOG_TEXT="${2:-Sürüm $VER}"
PANEL_API="${PANEL_API:-https://api.167-233-108-12.sslip.io}"
PLUGIN_DIR="apps/wp-plugin/jetlisans"

say(){ printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok(){  printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
err(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }

[ -n "$VER" ] || { err "Kullanım: ./scripts/release-plugin.sh <sürüm> [\"changelog\"]"; exit 1; }
echo "$VER" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || { err "Sürüm SemVer olmalı (ör. 0.2.0)."; exit 1; }
ADMIN_TOKEN="$(grep -E '^ADMIN_TOKEN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'"'\r' || true)"
[ -n "$ADMIN_TOKEN" ] || { err "ADMIN_TOKEN .env'de bulunamadı — panele yayınlanamaz."; exit 1; }

CUR="$(grep -m1 'Version:' "$PLUGIN_DIR/jetlisans.php" | sed -E 's/.*Version:[[:space:]]*//' | tr -d '\r')"
say "Eklenti sürümü: $CUR → $VER"

# 1) Sürüm numaralarını güncelle (görünen başlık + sabit + readme).
sed -i -E "s/^( \* Version:[[:space:]]*).*/\1$VER/" "$PLUGIN_DIR/jetlisans.php"
sed -i -E "s/(define\('JETLISANS_VERSION', ')[^']*('\);)/\1$VER\2/" "$PLUGIN_DIR/jetlisans.php"
sed -i -E "s/^(Stable tag:[[:space:]]*).*/\1$VER/" "$PLUGIN_DIR/readme.txt"
ok "Sürüm dosyaları güncellendi."

# 2) Yayın commit'i (yalnız bu iki dosya — başka staged değişikliği etkilemez).
git commit "$PLUGIN_DIR/jetlisans.php" "$PLUGIN_DIR/readme.txt" \
  -m "release(plugin): v$VER" >/dev/null 2>&1 || { err "Commit başarısız (değişiklik yok?)."; }

# 3) Temiz .zip paketle — git archive ile (harici 'zip' binary'sine gerek yok).
#    prefix=jetlisans/ → WP doğru klasöre açar. Sadece commit'li içerik paketlenir.
ZIP="$(mktemp -u).zip"
git archive --format=zip --prefix=jetlisans/ -o "$ZIP" "HEAD:$PLUGIN_DIR"
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
