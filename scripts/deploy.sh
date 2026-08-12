#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — Panel'i (API + Admin) prod'a dağıtır. VPS'te repo kökünde çalışır:
#   ssh ... 'cd /opt/lisans-yonetim-paneli && ./scripts/deploy.sh [servis...]'
#
# Yapar: temiz-ağaç kontrolü → git pull → build → up -d → sağlık bekle (dağıtılan
#        HER hedef) → BAŞARISIZSA otomatik geri alma (önceki commit) → ham deploy
#        geçmişine kayıt.
#
# Not: repo'daki görünür geçmiş docs/DEPLOY-LOG.md'dir (yayın commit'inde elle güncellenir);
# bu script ise .deploy-history.log'a (gitignore, sunucu-yerel) ham denetim satırı ekler →
# çalışma ağacını KİRLETMEZ (sonraki git pull --ff-only bozulmaz).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICES="${*:-api admin}"
HEALTH_URL="${HEALTH_URL:-https://api.167-233-108-12.sslip.io/v1/health}"
# Admin runtime probu: admin kök URL'i (auth AÇIKKEN 3xx döner — yine de "runtime ayakta"
# demektir; yalnız gateway hatası/erişilemezlik sağlıksız sayılır). Yalnız SERVICES'te
# 'admin' varsa kontrol edilir (admin-only deploy'un runtime çöküşü de yakalanır).
ADMIN_HEALTH_URL="${ADMIN_HEALTH_URL:-https://admin.167-233-108-12.sslip.io/}"
LOG=".deploy-history.log"

# Renkler YALNIZ gerçek TTY'de. Runner çıktıyı $(...) ile yakaladığında stdout TTY değildir →
# ham \033[..m escape kodları DB log/error alanına (ve /deployments UI'sine) sızmaz.
if [ -t 1 ]; then
  C_SAY=$'\033[1;36m'; C_OK=$'\033[1;32m'; C_ERR=$'\033[1;31m'; C_RST=$'\033[0m'
else
  C_SAY=''; C_OK=''; C_ERR=''; C_RST=''
fi
say(){ printf '\n%s▸ %s%s\n' "$C_SAY" "$*" "$C_RST"; }
ok(){  printf '%s✓ %s%s\n' "$C_OK" "$*" "$C_RST"; }
err(){ printf '%s✗ %s%s\n' "$C_ERR" "$*" "$C_RST" >&2; }

health(){ curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'; }
# Admin runtime: HTTP yanıtı var + gateway hatası değil (2xx/3xx/4xx ok; 5xx / bağlantı yok = sağlıksız).
admin_health(){
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$ADMIN_HEALTH_URL" 2>/dev/null)" || code=000
  [ -n "$code" ] && [ "$code" -ge 200 ] && [ "$code" -lt 500 ]
}
# Dağıtılan TÜM hedefler sağlıklı mı: API her zaman; admin yalnız SERVICES'te varsa.
all_healthy(){
  health || return 1
  case " $SERVICES " in *" admin "*) admin_health || return 1;; esac
  return 0
}

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
# Bir önceki başarısız rollback (eski sürüm) repoyu detached HEAD'de bırakmış olabilir →
# 'git pull --ff-only' orada fatal verirdi. Dala dön (self-heal), böylece ff-pull çalışır.
if [ "$BRANCH" = "HEAD" ]; then
  err "Repo detached HEAD'de — 'main' dalına dönülüyor (self-heal)."
  git checkout main
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
fi

OLD="$(git rev-parse --short HEAD)"
say "Dağıtım başlıyor (servis: $SERVICES, dal: $BRANCH) — mevcut sürüm: $OLD"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  err "Çalışma ağacında commit'lenmemiş değişiklik var — 'git pull --ff-only' yapılamaz. Önce temizle."
  exit 1
fi

say "git pull…"
git pull --ff-only
NEW="$(git rev-parse --short HEAD)"
[ "$OLD" = "$NEW" ] && ok "Yeni commit yok ($NEW) — yine de rebuild ediliyor." || ok "$OLD → $NEW"

STAMP="$(date '+%Y-%m-%d %H:%M')"

# Geri alma: dala BAĞLI kalarak eski commit'e sar. 'git checkout <sha>' DETACHED HEAD üretir
# ve sonraki tüm deploy'ları kilitlerdi → 'git reset --hard' ile HEAD dala bağlı kalır (ff-pull
# ileride yine ileri sarar). Build/up hatası da (yalnız sağlık değil) buraya düşer.
rollback(){
  err "Geri alınıyor: $NEW → $OLD (dal: $BRANCH)"
  git reset --hard "$OLD"
  if docker compose build $SERVICES && docker compose up -d $SERVICES && all_healthy; then
    err "Geri alındı ve sağlıklı ($OLD). Yeni sürüm ($NEW) İPTAL edildi."
    printf '%s\t%s\t%s\t%s\tROLLBACK-OK\n' "$STAMP" "$NEW" "$SERVICES" "deploy-FAILED" >> "$LOG"
  else
    err "GERİ ALMA SONRASI DA SAĞLIKSIZ — ELLE MÜDAHALE GEREK ('docker compose logs')."
    printf '%s\t%s\t%s\t%s\tROLLBACK-FAIL\n' "$STAMP" "$NEW" "$SERVICES" "deploy-FAILED" >> "$LOG"
  fi
  exit 1
}

# Build/up başarısızsa set -e sessizce öldürmesin → açıkça rollback tetikle.
say "Build: $SERVICES"; docker compose build $SERVICES || rollback
say "Başlat: $SERVICES"; docker compose up -d $SERVICES || rollback

case " $SERVICES " in *" admin "*) PROBE="API + admin";; *) PROBE="API";; esac
say "Sağlık bekleniyor ($PROBE)…"
OKH=0; for i in $(seq 1 30); do if all_healthy; then OKH=1; break; fi; sleep 2; done

if [ "$OKH" = 1 ]; then
  ok "Sağlıklı. Dağıtım tamam: $NEW ($SERVICES)"
  printf '%s\t%s\t%s\t%s\tOK\n' "$STAMP" "$NEW" "$SERVICES" "deploy" >> "$LOG"

  # DİSK SIZINTISI TEMİZLİĞİ (denetim bulgusu): her dağıtım yeni imaj katmanı + build cache
  # üretiyor, eskisi ASLA silinmiyordu → tek VPS'te disk doluyor (ölçüldü: 68 GB build cache,
  # 150 GB diskin %56'sı). Disk dolarsa PostgreSQL yazamaz = TÜM teslimat durur.
  # YALNIZ başarılı dağıtımdan SONRA ve YALNIZ dangling/eski önbellek: çalışan konteynerlerin
  # imajları ve rollback için gereken ÖNCEKİ imaj etkilenmez (`-a` KULLANILMAZ). Hata olursa
  # dağıtımı BAŞARISIZ sayma (temizlik kritik değil) → `|| true`.
  say "Disk temizliği (dangling imaj + 7 günden eski build cache)…"
  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -f --filter 'until=168h' >/dev/null 2>&1 || true
  ok "Temizlik bitti. Kalan disk: $(df -h / | awk 'NR==2{print $4" boş ("$5" dolu)"}')"

  say "docs/DEPLOY-LOG.md'ye satır eklemeyi unutma (görünür geçmiş)."
else
  err "SAĞLIK BAŞARISIZ ($NEW)."
  rollback
fi
