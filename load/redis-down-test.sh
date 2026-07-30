#!/usr/bin/env bash
# Fault-injection: Redis DÜŞERSE sipariş push (HMAC nonce Redis'e yazar) ne olur?
# Dev izole ortamda çalışır. lisansdev-redis-1 pause → push dene → unpause → tekrar dene.
set -uo pipefail
DEV=/opt/lisans-dev
DT="$(grep -E '^ADMIN_TOKEN=' "$DEV/.env.dev" | head -1 | cut -d= -f2- | tr -d '\r"')"
HOST_API="http://127.0.0.1:3002"
NET=lisansdev_default
RID="ft-$(date +%s)"

adminpost() { curl -s --max-time 10 -X POST -H "X-Admin-Token: $DT" -H 'Content-Type: application/json' -d "$2" "$HOST_API$1"; }
# Düz JSON'dan string alan çıkar (host'ta node/jq gerektirmez).
jval() { grep -oE "\"$2\":\"[^\"]*\"" <<<"$1" | head -1 | sed -E "s/\"$2\":\"([^\"]*)\"/\1/"; }

echo "== KURULUM (redis ayakta) =="
SITE_JSON="$(adminpost /v1/admin/sites "{\"domain\":\"$RID.example.test\",\"type\":\"woocommerce\"}")"
API_KEY="$(jval "$SITE_JSON" apiKey)"
SECRET="$(jval "$SITE_JSON" hmacSecret)"
SID="$(jval "$SITE_JSON" id)"
[ -z "$API_KEY" ] && { echo "site oluşturulamadı: $SITE_JSON"; exit 1; }
PROD_JSON="$(adminpost /v1/admin/products "{\"sku\":\"$RID\",\"name\":\"FT\",\"kind\":\"key\",\"usageMode\":\"single\"}")"
PID="$(jval "$PROD_JSON" id)"
adminpost /v1/admin/stock/import "{\"productId\":\"$PID\",\"items\":[{\"payload\":\"FTKEY-$RID-0\"},{\"payload\":\"FTKEY-$RID-1\"},{\"payload\":\"FTKEY-$RID-2\"}]}" >/dev/null
adminpost /v1/admin/mappings "{\"siteId\":\"$SID\",\"productId\":\"$PID\",\"remoteProductId\":\"ft-remote\"}" >/dev/null
echo "kurulum OK (site=$SID ürün=$PID)"

runpush() {
  local rid="$1"
  local body="{\"remoteOrderId\":\"$rid\",\"customerEmail\":\"b@ft.test\",\"lines\":[{\"remoteLineId\":\"l1\",\"remoteProductId\":\"ft-remote\",\"qty\":1}]}"
  docker run --rm --network "$NET" -v "$DEV/load:/s" \
    -e BASE=http://api:3001 -e API_KEY="$API_KEY" -e SECRET="$SECRET" \
    -e METHOD=POST -e REQ_PATH=/v1/orders -e BODY="$body" node:22-alpine node /s/hmac-req.js
}

echo; echo "== 1) BASELINE push (redis ayakta) =="
t0=$(date +%s%3N); runpush "$RID-base"; echo "süre: $(( $(date +%s%3N) - t0 )) ms"

echo; echo "== 2) REDIS DURAKLATILIYOR (docker pause) =="
docker pause lisansdev-redis-1 >/dev/null && echo "redis paused"
echo "-- push (redis YOK) --"
t0=$(date +%s%3N); runpush "$RID-down"; echo "süre: $(( $(date +%s%3N) - t0 )) ms"
echo "-- health (redis YOK) --"
curl -s --max-time 6 "$HOST_API/v1/health" || echo "(health yanıt yok/timeout)"

echo; echo "== 3) REDIS GERİ (docker unpause) =="
docker unpause lisansdev-redis-1 >/dev/null && echo "redis unpaused"
sleep 3
echo "-- push (redis geri) --"
t0=$(date +%s%3N); runpush "$RID-recover"; echo "süre: $(( $(date +%s%3N) - t0 )) ms"
echo "-- health (redis geri) --"
curl -s --max-time 6 "$HOST_API/v1/health"; echo

echo; echo "== ÖZET: redis-down davranışı yukarıda (STATUS satırları) =="
