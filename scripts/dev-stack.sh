#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# dev-stack.sh — VPS'te İZOLE dev/staging yığınını kurar/yönetir. PROD'A DOKUNMAZ:
# ayrı proje adı (-p lisansdev) → ayrı container/ağ/volume; ayrı klasör (/opt/lisans-dev)
# + ayrı .env.dev → ayrı DB + dev sırları. Test siparişleri prod DB'ye ASLA yazılmaz.
#
#   ssh ... '/opt/lisans-yonetim-paneli/scripts/dev-stack.sh [up|wp|down|status]'
#     up     : izole panel yığını (postgres/redis/mailpit/api/admin) — build + health
#     wp     : izole WordPress dev sitesi (dev panele bağlı ağda)
#     down   : izole yığını durdur
#     status : durum
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROD_DIR="/opt/lisans-yonetim-paneli"
DEV_DIR="/opt/lisans-dev"
PROJECT="lisansdev"
DEV_API_PORT=3002
DEV_ADMIN_PORT=3006

say(){ printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok(){  printf '\033[1;32m✓ %s\033[0m\n' "$*"; }

dc(){ docker compose -p "$PROJECT" --env-file "$DEV_DIR/.env.dev" \
        -f "$DEV_DIR/docker-compose.yml" -f "$DEV_DIR/docker-compose.dev.yml" "$@"; }

ensure_repo(){
  if [ ! -d "$DEV_DIR/.git" ]; then
    say "Dev repo klonlanıyor → $DEV_DIR (prod dizininden)"
    git clone "$PROD_DIR" "$DEV_DIR"
    git -C "$DEV_DIR" remote set-url origin "$(git -C "$PROD_DIR" remote get-url origin)"
    git -C "$DEV_DIR" config core.filemode false
  fi
  git -C "$DEV_DIR" pull --ff-only origin main 2>/dev/null || say "(uzaktan pull atlandı — mevcut checkout kullanılıyor)"
}

ensure_env(){
  [ -f "$DEV_DIR/.env.dev" ] && return 0
  say ".env.dev üretiliyor — DEV sırları (prod'dan TAMAMEN AYRI)"
  cat > "$DEV_DIR/.env.dev" <<ENV
NODE_ENV=development
TZ=Europe/Istanbul
POSTGRES_USER=devuser
POSTGRES_PASSWORD=devpass
POSTGRES_DB=lisansdev
DATABASE_URL=postgres://devuser:devpass@postgres:5432/lisansdev
REDIS_URL=redis://redis:6379
MASTER_KEY=$(openssl rand -base64 32)
ADMIN_TOKEN=$(openssl rand -hex 24)
ADMIN_DOMAIN=dev-admin.localhost
API_DOMAIN=dev-api.localhost
ENV
  ok ".env.dev oluşturuldu (auth KAPALI — dev kolaylığı; SESSION_SECRET yok)."
}

case "${1:-up}" in
  up)
    ensure_repo; ensure_env
    say "İzole panel yığını kalkıyor (proje: $PROJECT; ilk seferde imaj derlenir)…"
    ( cd "$DEV_DIR" && dc up -d --build postgres redis mailpit api admin )
    say "Sağlık bekleniyor (http://127.0.0.1:$DEV_API_PORT/v1/health)…"
    for i in $(seq 1 45); do
      curl -fsS "http://127.0.0.1:$DEV_API_PORT/v1/health" >/dev/null 2>&1 && { ok "Dev API sağlıklı."; break; }
      sleep 2
    done
    echo
    ok "İZOLE DEV PANEL HAZIR"
    echo "  Dev API   : http://127.0.0.1:$DEV_API_PORT/v1/health   (yalnız localhost)"
    echo "  Dev Admin : http://127.0.0.1:$DEV_ADMIN_PORT           (auth kapalı)"
    echo "  Dış erişim: SSH tüneli (ör. ssh -L $DEV_ADMIN_PORT:127.0.0.1:$DEV_ADMIN_PORT ...) veya prod Caddy'ye dev alt-alan adı."
    echo "  Prod'a dokunmaz: ayrı DB (lisansdev) + ağ (${PROJECT}_default) + volume'ler."
    ;;
  wp)
    ensure_env
    say "İzole WordPress dev sitesi kalkıyor (ağ: ${PROJECT}_default, port 8091)…"
    ( cd "$DEV_DIR" && PANEL_NETWORK="${PROJECT}_default" WP_BIND="127.0.0.1:8091" WP_SITE_URL="http://127.0.0.1:8091" \
        docker compose -p "$PROJECT" -f "$DEV_DIR/docker-compose.wp.yml" up -d )
    ok "İzole WP dev :8091 (localhost). Dev panele bağlamak için wpcli + dev ADMIN_TOKEN ile site aç (wp-dev.sh mantığı)."
    ;;
  down)
    ( cd "$DEV_DIR" && dc down || true )
    ( cd "$DEV_DIR" && PANEL_NETWORK="${PROJECT}_default" docker compose -p "$PROJECT" -f "$DEV_DIR/docker-compose.wp.yml" down 2>/dev/null || true )
    ok "İzole dev yığını durduruldu (volume'ler korunur)."
    ;;
  status)
    docker compose -p "$PROJECT" ps || true
    ;;
  *) echo "Kullanım: dev-stack.sh [up|wp|down|status]"; exit 1 ;;
esac
