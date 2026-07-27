#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# wp-dev.sh — Yerel WordPress + WooCommerce geliştirme sitesini TEK KOMUTLA kurar
# ve panele bağlar. Tekrarlanabilir/idempotent: tekrar çalıştırmak güvenlidir.
#
#   bash scripts/wp-dev.sh
#
# Ne yapar:
#   1. Panel yığınını (postgres/redis/api/admin/caddy/mailpit) ayağa kaldırır.
#   2. WP yığınını (wordpress/mysql/wpcli) ayağa kaldırır.
#   3. WordPress çekirdeğini kurar (idempotent) + kalıcı bağlantı (permalink) açar.
#   4. WooCommerce'i kurar + aktive eder.
#   5. WP eklentisini aktive eder.
#   6. Panelde bu site için kayıt açar (ADMIN_TOKEN ile), api_key + hmac_secret'ı
#      alıp WP'ye SABİT (wp-config) olarak yazar → "normal bir siteye bağlanmış gibi".
#
# Erişim (script sonunda özetlenir):
#   WP sitesi   : http://localhost:8090   (yönetici: kullanıcı 'admin' / parola 'admin12345')
#   Panel admin : http://localhost:3005   (auth kapalıysa doğrudan açılır)
#   Mailpit     : http://localhost:8025
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

WP_COMPOSE="docker compose -f docker-compose.wp.yml"
SITE_URL="http://localhost:8090"
WP_ADMIN_USER="admin"
WP_ADMIN_PASS="admin12345"
WP_ADMIN_EMAIL="admin@ornek-site.local"
API_HOST="http://localhost:3001"                    # override ile host'a açık
PANEL_URL_INTERNAL="http://api:3001"                 # WP container'ından panel
WEBHOOK_URL="http://wordpress/wp-json/wpteslimat/v1/webhook"  # panelden WP'ye

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }

# wpcli container'ında `wp` çalıştır (stdin kapalı; -T).
wpc() { $WP_COMPOSE exec -T wpcli wp "$@"; }

# ── 0) Ön koşullar ───────────────────────────────────────────────────────────
[ -f .env ] || { warn ".env bulunamadı — 'cp .env.example .env' yapıp doldurun."; exit 1; }
# .env'den ADMIN_TOKEN oku (panel site oluşturma için).
ADMIN_TOKEN="$(grep -E '^ADMIN_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'"'\r' || true)"

# ── 1) Panel yığını ──────────────────────────────────────────────────────────
say "Panel yığını ayağa kaldırılıyor (ilk seferde api/admin imajları derlenir — sabırlı olun)…"
docker compose up -d

say "API sağlık bekleniyor ($API_HOST/v1/health)…"
for i in $(seq 1 60); do
  if curl -fsS "$API_HOST/v1/health" >/dev/null 2>&1; then ok "API hazır."; break; fi
  [ "$i" = 60 ] && { warn "API 120sn'de hazır olmadı — 'docker compose logs api' bakın."; }
  sleep 2
done

# ── 2) WP yığını ─────────────────────────────────────────────────────────────
say "WordPress yığını ayağa kaldırılıyor…"
$WP_COMPOSE up -d

say "WordPress/DB bekleniyor…"
for i in $(seq 1 60); do
  if wpc core version >/dev/null 2>&1; then ok "WP-CLI + veritabanı hazır."; break; fi
  [ "$i" = 60 ] && { warn "WP-CLI 120sn'de hazır olmadı — '$WP_COMPOSE logs wordpress' bakın."; exit 1; }
  sleep 2
done

# ── 3) WordPress çekirdek kurulumu ───────────────────────────────────────────
if wpc core is-installed >/dev/null 2>&1; then
  ok "WordPress zaten kurulu."
else
  say "WordPress kuruluyor…"
  wpc core install --url="$SITE_URL" --title="Dev Mağaza" \
    --admin_user="$WP_ADMIN_USER" --admin_password="$WP_ADMIN_PASS" \
    --admin_email="$WP_ADMIN_EMAIL" --skip-email
  ok "WordPress kuruldu."
fi

# Kalıcı bağlantılar (REST /wp-json + webhook alıcı için ŞART).
wpc rewrite structure '/%postname%/' >/dev/null 2>&1 || true
wpc rewrite flush >/dev/null 2>&1 || true

# ── 4) WooCommerce ───────────────────────────────────────────────────────────
if wpc plugin is-active woocommerce >/dev/null 2>&1; then
  ok "WooCommerce aktif."
else
  say "WooCommerce kuruluyor + aktive ediliyor…"
  wpc plugin install woocommerce --activate
  ok "WooCommerce aktif."
fi

# ── 5) Panele bağla (site kaydı + sabitler) ──────────────────────────────────
if wpc config has WPTESLIMAT_API_KEY >/dev/null 2>&1; then
  ok "Panel bağlantısı zaten yapılandırılmış (WPTESLIMAT_API_KEY sabiti mevcut)."
elif [ -z "$ADMIN_TOKEN" ]; then
  warn "ADMIN_TOKEN .env'de boş — panel bağlantısı otomatik kurulamadı. Elle: panelde site oluşturup"
  warn "  wp config set WPTESLIMAT_API_KEY '<key>' --type=constant  (wpcli) ile bağlayın."
else
  say "Panelde site kaydı oluşturuluyor…"
  RESP="$(curl -fsS -X POST "$API_HOST/v1/admin/sites" \
    -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"domain\":\"localhost:8090\",\"type\":\"woocommerce\",\"webhookUrl\":\"$WEBHOOK_URL\"}" 2>/dev/null || true)"
  API_KEY="$(printf '%s' "$RESP" | grep -oE '"apiKey":"[^"]*"' | sed 's/.*:"//;s/"$//')"
  HMAC="$(printf '%s' "$RESP" | grep -oE '"hmacSecret":"[^"]*"' | sed 's/.*:"//;s/"$//')"
  if [ -n "$API_KEY" ] && [ -n "$HMAC" ]; then
    wpc config set WPTESLIMAT_API_KEY "$API_KEY" --type=constant >/dev/null
    wpc config set WPTESLIMAT_HMAC_SECRET "$HMAC" --type=constant >/dev/null
    ok "Panel sitesi oluşturuldu ve WP'ye bağlandı (api_key + hmac_secret sabit yazıldı)."
  else
    warn "Panel sitesi oluşturulamadı (aynı domain zaten kayıtlı olabilir). Yanıt: ${RESP:0:200}"
    warn "  Panelden mevcut sitenin secret'ını rotate edip elle bağlayabilirsiniz."
  fi
fi

# ── 6) Eklentiyi aktive et (bağlantı sabitleri yazıldıktan SONRA → bound_home tabanı kurulur) ─
if wpc plugin is-active wpteslimat >/dev/null 2>&1; then
  wpc plugin deactivate wpteslimat >/dev/null 2>&1 || true   # bound_home tabanını taze yaz
fi
say "WP Teslimat Eklentisi aktive ediliyor…"
wpc plugin activate wpteslimat && ok "Eklenti aktif."

# ── Özet ─────────────────────────────────────────────────────────────────────
cat <<SUMMARY

──────────────────────────────────────────────────────────────
  YEREL GELİŞTİRME ORTAMI HAZIR
──────────────────────────────────────────────────────────────
  WordPress sitesi : $SITE_URL        (wp-admin: $WP_ADMIN_USER / $WP_ADMIN_PASS)
  Panel admin      : http://localhost:3005
  Panel API        : $API_HOST/v1/health
  Mailpit (mail)   : http://localhost:8025

  Eklenti kaynağı bind-mount: apps/wp-plugin/wpteslimat → düzenle, WP'de anında yansır.
  Test akışı: panelde ürün+eşleme+stok gir → WooCommerce'te sipariş oluştur →
              "Siparişlerim"de çözülmüş key'i gör.

  Durdur:  docker compose -f docker-compose.wp.yml down   (panel: docker compose down)
──────────────────────────────────────────────────────────────
SUMMARY
