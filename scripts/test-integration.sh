#!/usr/bin/env bash
#
# İZOLE ENTEGRASYON + YARIŞ TESTİ — tek komut.
#
# NEDEN VAR: bu paket (gerçek PostgreSQL + Redis ister) projenin en değerli doğrulama adımı
# ama tekrarlanabilir bir giriş noktası YOKTU — her seferinde elle kuruluyordu ve elle kurulum
# ÜÇ KEZ sahte/eksik doğrulamaya yol açtı:
#   · `db:migrate` unutuldu → "tablo yok" (kod regresyonu sanıldı),
#   · `REDIS_URL` verilmedi → hız sınırı `beforeAll`'ı patladı (yeni testler kapısız kaldı),
#   · BAYAT `node_modules` — checkout'ta lockfile'ın istediğinden ESKİ vitest duruyordu (2.1.9
#     vs 3.2.6) ve paket sessizce yanlış araç zinciriyle koştu; "geçti" demek, doğru sürümlerle
#     geçti demek DEĞİLDİ. Bu yüzden koşu `--frozen-lockfile` kurulumla başlar.
# Betik üçünü de imkânsız kılar.
#
# İZOLASYON: kendi ağı + kendi PG/Redis konteynerleri (`lisanstest-*`). Prod (`lisans-yonetim-
# paneli`) ve dev (`lisansdev`) yığınlarına HİÇ dokunmaz; port da yayınlamaz (yalnız ağ içi) →
# hostta çalışan bir PG/Redis ile çakışmaz.
#
# GÜVENLİK: DB adı `lisanspanel_test`. Paketin `globalSetup`'ı koşu başında TRUNCATE koşar ve
# adı test kalıbına uymayan bir DB'de fail-closed durur (bkz. test/integration/_global-setup.ts).
# Buradaki ad o kilidi bilerek karşılar; başka bir DB'ye yönlendirmeyin.
#
# MASTER_KEY: her koşuda TAZE üretilir. Sabitlemek cazip ama YANLIŞ olurdu — birkaç test
# etiketsiz sabit payload kullanıyor ve `payload_hash` GLOBAL unique; sabit anahtar o çakışmayı
# canlandırır (import mükerreri SESSİZCE atlar, `imported` eksilir).
#
# KULLANIM:
#   ./scripts/test-integration.sh              # entegrasyon + yarış, sonra temizle
#   ./scripts/test-integration.sh integration  # yalnız entegrasyon
#   ./scripts/test-integration.sh race         # yalnız yarış
#   KEEP=1 ./scripts/test-integration.sh       # konteynerleri bırak (hata ayıklama)
#   SKIP_INSTALL=1 ./scripts/test-integration.sh   # kurulumu atla (yalnız ağsız ortamda;
#                                                  # bağımlılık sapması riskini KABUL EDERSİN)
#
# GEREKSİNİM: docker. Node/pnpm HOSTTA GEREKMEZ — her şey node:22 konteynerinde koşar
# (VPS'te node PATH'te değil; betik bu yüzden konteyner içinden çalışır).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NET=lisanstest_net
PG=lisanstest-pg
REDIS=lisanstest-redis
RUNNER=lisanstest-runner
DB=lisanspanel_test
KEEP="${KEEP:-}"
WHAT="${1:-all}"

case "$WHAT" in
  all | integration | race) ;;
  *)
    echo "Kullanım: $0 [all|integration|race]" >&2
    exit 2
    ;;
esac

# Renk yalnız TTY'de (runner logu/panel çıktısı kirlenmesin — deploy.sh ile aynı kural).
if [ -t 1 ]; then G='\033[0;32m'; R='\033[0;31m'; Y='\033[1;33m'; N='\033[0m'; else G=''; R=''; Y=''; N=''; fi
log() { printf "%b\n" "${Y}==>${N} $*"; }
ok() { printf "%b\n" "${G}✓${N} $*"; }
die() {
  printf "%b\n" "${R}✗${N} $*" >&2
  exit 1
}

cleanup() {
  local code=$?
  if [ -n "$KEEP" ]; then
    log "KEEP=1 — konteynerler bırakıldı ($PG, $REDIS, ağ: $NET). Temizlik: docker rm -f $PG $REDIS $RUNNER; docker network rm $NET"
    return $code
  fi
  log "temizlik…"
  docker rm -f "$RUNNER" "$PG" "$REDIS" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  return $code
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || die "docker bulunamadı."

# Önceki koşumdan kalıntı varsa (KEEP ya da çökme) sıfırdan başla — bayat şema/veri, arızayı
# kod regresyonu gibi gösterir.
docker rm -f "$RUNNER" "$PG" "$REDIS" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true

log "izole ağ + PostgreSQL 17 + Redis 7"
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB="$DB" -e TZ=Europe/Istanbul \
  --tmpfs /var/lib/postgresql/data \
  postgres:17 >/dev/null
docker run -d --name "$REDIS" --network "$NET" redis:7 >/dev/null

log "PostgreSQL hazır olması bekleniyor…"
for i in $(seq 1 60); do
  if docker exec "$PG" pg_isready -U postgres -d "$DB" >/dev/null 2>&1; then break; fi
  [ "$i" -eq 60 ] && die "PostgreSQL 60 sn içinde hazır olmadı."
  sleep 1
done
ok "PostgreSQL hazır"

MASTER_KEY="$(openssl rand -base64 32)"

# Kurulum ÖNCE: checkout'un node_modules'ü lockfile'dan sapmış olabilir (ölçüldü: vitest 2.1.9
# duruyorken package.json ^3.2.6 istiyordu). `--frozen-lockfile` sapmayı hata yapar.
if [ -n "${SKIP_INSTALL:-}" ]; then
  INSTALL='echo "SKIP_INSTALL=1 — bagimlilik kurulumu atlandi (sapma riski kabul edildi)."'
else
  INSTALL='pnpm install --frozen-lockfile --prefer-offline'
fi

MIGRATE='pnpm --filter @lisans/api db:migrate'
case "$WHAT" in
  integration) CMD="$INSTALL && $MIGRATE && pnpm --filter @lisans/api test:integration" ;;
  race) CMD="$INSTALL && $MIGRATE && pnpm --filter @lisans/api test:race" ;;
  all) CMD="$INSTALL && $MIGRATE && pnpm --filter @lisans/api test:integration && pnpm --filter @lisans/api test:race" ;;
esac

log "kurulum + migration + test ($WHAT)"
set +e
docker run --rm --name "$RUNNER" --network "$NET" \
  -v "$ROOT:/app" -w /app \
  -e DATABASE_URL="postgres://postgres:postgres@$PG:5432/$DB" \
  -e REDIS_URL="redis://$REDIS:6379" \
  -e MASTER_KEY="$MASTER_KEY" \
  -e TZ=Europe/Istanbul \
  -e CI=1 \
  node:22 \
  bash -lc "corepack enable >/dev/null 2>&1; $CMD"
code=$?
set -e

[ "$code" -eq 0 ] || die "test paketi başarısız (çıkış $code)."
ok "$WHAT paketi geçti"
