#!/usr/bin/env bash
# Fault-injection: PG advisory-lock TUTULURKEN createOrder + /health ne olur?
# DÜZELTME ÖNCESİ: istek 50sn+ askıda, /health yanıtsız (havuz kilitli).
# DÜZELTME SONRASI: istek ~lock_timeout/statement_timeout'ta (10-30sn) HATA döner, /health HIZLI.
# Dev izole ortam. Kota-açık site → createOrder pg_advisory_xact_lock(hashtext(siteId)) alır.
set -uo pipefail
DEV=/opt/lisans-dev
DT="$(grep -E '^ADMIN_TOKEN=' "$DEV/.env.dev" | head -1 | cut -d= -f2- | tr -d '\r"')"
HOST_API="http://127.0.0.1:3002"
NET=lisansdev_default
PG=lisansdev-postgres-1
DBU=devuser; DBN=lisansdev
RID="pglock-$(date +%s)"
jval() { grep -oE "\"$2\":\"[^\"]*\"" <<<"$1" | head -1 | sed -E "s/\"$2\":\"([^\"]*)\"/\1/"; }
adminpost() { curl -s --max-time 10 -X POST -H "X-Admin-Token: $DT" -H 'Content-Type: application/json' -d "$2" "$HOST_API$1"; }

echo "== KURULUM =="
SJ="$(adminpost /v1/admin/sites "{\"domain\":\"$RID.test\",\"type\":\"woocommerce\"}")"
AK="$(jval "$SJ" apiKey)"; SC="$(jval "$SJ" hmacSecret)"; SID="$(jval "$SJ" id)"
[ -z "$AK" ] && { echo "site yok: $SJ"; exit 1; }
PJ="$(adminpost /v1/admin/products "{\"sku\":\"$RID\",\"name\":\"PL\",\"kind\":\"key\",\"usageMode\":\"single\"}")"
PID="$(jval "$PJ" id)"
adminpost /v1/admin/stock/import "{\"productId\":\"$PID\",\"items\":[{\"payload\":\"PL-$RID-0\"},{\"payload\":\"PL-$RID-1\"}]}" >/dev/null
adminpost /v1/admin/mappings "{\"siteId\":\"$SID\",\"productId\":\"$PID\",\"remoteProductId\":\"pl-remote\"}" >/dev/null
# Sert kota aç → createOrder advisory-lock alır.
docker exec "$PG" psql -U "$DBU" -d "$DBN" -X -c "UPDATE sites SET sales_daily_quota=100000 WHERE id='$SID';" >/dev/null
echo "kurulum OK (site=$SID, kota açık)"

echo; echo "== ADVISORY LOCK TUTULUYOR (arka planda 40sn) =="
# Aynı anahtarı (hashtext(siteId)) tutan bir tx aç, 40sn uyut.
docker exec "$PG" psql -U "$DBU" -d "$DBN" -X -c "BEGIN; SELECT pg_advisory_xact_lock(hashtext('$SID')); SELECT pg_sleep(40); COMMIT;" >/tmp/pglock.out 2>&1 &
LOCKPID=$!
sleep 3   # lock alınsın

echo "-- createOrder (kilit BAŞKASINDA) — süre/status? --"
BODY="{\"remoteOrderId\":\"$RID-o1\",\"customerEmail\":\"b@pl.test\",\"lines\":[{\"remoteLineId\":\"l1\",\"remoteProductId\":\"pl-remote\",\"qty\":1}]}"
t0=$(date +%s%3N)
docker run --rm --network "$NET" -v "$DEV/load:/s" -e BASE=http://api:3001 -e API_KEY="$AK" -e SECRET="$SC" \
  -e METHOD=POST -e REQ_PATH=/v1/orders -e BODY="$BODY" node:22-alpine node /s/hmac-req.js
echo "createOrder süresi: $(( $(date +%s%3N) - t0 )) ms   (beklenen: ~10000-30000ms HATA; düzeltme ÖNCESİ ~40000ms askı)"

echo "-- AYNI ANDA /health — HIZLI mı? --"
t0=$(date +%s%3N)
curl -s --max-time 6 "$HOST_API/v1/health" || echo "(health timeout>6s)"
echo "   health süresi: $(( $(date +%s%3N) - t0 )) ms   (beklenen: <1000ms)"

echo; echo "== kilit bırakılıyor (bekle) =="
wait $LOCKPID 2>/dev/null; echo "lock tx bitti"
sleep 2
echo "-- createOrder (kilit YOK) — normal? --"
t0=$(date +%s%3N)
docker run --rm --network "$NET" -v "$DEV/load:/s" -e BASE=http://api:3001 -e API_KEY="$AK" -e SECRET="$SC" \
  -e METHOD=POST -e REQ_PATH=/v1/orders -e BODY="{\"remoteOrderId\":\"$RID-o2\",\"customerEmail\":\"b@pl.test\",\"lines\":[{\"remoteLineId\":\"l1\",\"remoteProductId\":\"pl-remote\",\"qty\":1}]}" node:22-alpine node /s/hmac-req.js
echo "normal createOrder süresi: $(( $(date +%s%3N) - t0 )) ms"
echo; echo "== ÖZET yukarıda =="
