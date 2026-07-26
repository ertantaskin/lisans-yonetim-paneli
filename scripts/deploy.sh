#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — Panel'i (API + Admin) prod'a dağıtır. VPS'te repo kökünde çalışır:
#   ssh ... 'cd /opt/lisans-yonetim-paneli && ./scripts/deploy.sh [servis...]'
#
# Yapar: temiz-ağaç kontrolü → git pull → build → up -d → /health 200 bekle →
#        BAŞARISIZSA otomatik geri alma (önceki commit) → ham deploy geçmişine kayıt.
#
# Not: repo'daki görünür geçmiş docs/DEPLOY-LOG.md'dir (yayın commit'inde elle güncellenir);
# bu script ise .deploy-history.log'a (gitignore, sunucu-yerel) ham denetim satırı ekler →
# çalışma ağacını KİRLETMEZ (sonraki git pull --ff-only bozulmaz).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICES="${*:-api admin}"
HEALTH_URL="${HEALTH_URL:-https://api.167-233-108-12.sslip.io/v1/health}"
LOG=".deploy-history.log"

say(){ printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok(){  printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
err(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }
health(){ curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'; }

OLD="$(git rev-parse --short HEAD)"
say "Dağıtım başlıyor (servis: $SERVICES) — mevcut sürüm: $OLD"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  err "Çalışma ağacında commit'lenmemiş değişiklik var — 'git pull --ff-only' yapılamaz. Önce temizle."
  exit 1
fi

say "git pull…"
git pull --ff-only
NEW="$(git rev-parse --short HEAD)"
[ "$OLD" = "$NEW" ] && ok "Yeni commit yok ($NEW) — yine de rebuild ediliyor." || ok "$OLD → $NEW"

say "Build: $SERVICES"; docker compose build $SERVICES
say "Başlat: $SERVICES"; docker compose up -d $SERVICES

say "Sağlık bekleniyor ($HEALTH_URL)…"
OKH=0; for i in $(seq 1 30); do if health; then OKH=1; break; fi; sleep 2; done

STAMP="$(date '+%Y-%m-%d %H:%M')"
if [ "$OKH" = 1 ]; then
  ok "Sağlıklı. Dağıtım tamam: $NEW ($SERVICES)"
  printf '%s\t%s\t%s\t%s\tOK\n' "$STAMP" "$NEW" "$SERVICES" "deploy" >> "$LOG"
  say "docs/DEPLOY-LOG.md'ye satır eklemeyi unutma (görünür geçmiş)."
else
  err "SAĞLIK BAŞARISIZ ($NEW) — otomatik geri alınıyor: $NEW → $OLD"
  git checkout "$OLD"
  docker compose build $SERVICES
  docker compose up -d $SERVICES
  if health; then
    err "Geri alındı ve sağlıklı ($OLD). Yeni sürüm ($NEW) İPTAL edildi."
    printf '%s\t%s\t%s\t%s\tROLLBACK-OK\n' "$STAMP" "$NEW" "$SERVICES" "deploy-FAILED" >> "$LOG"
  else
    err "GERİ ALMA SONRASI DA SAĞLIKSIZ — ELLE MÜDAHALE GEREK ('docker compose logs api')."
    printf '%s\t%s\t%s\t%s\tROLLBACK-FAIL\n' "$STAMP" "$NEW" "$SERVICES" "deploy-FAILED" >> "$LOG"
  fi
  exit 1
fi
