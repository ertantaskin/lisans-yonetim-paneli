#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Jetlisans — Yedek / Geri-Yükleme TATBİKATI (backup drill)   · MIMARI.md §16 DR
# ─────────────────────────────────────────────────────────────────────────────
# Amaç (§16): RPO≤5dk / RTO≤2sa hedefleri için AYLIK yedek tatbikatı. Prod
# PostgreSQL'den mantıksal yedek alır, AYRI bir "${DB}_drill" doğrulama
# veritabanına geri yükler, kritik tabloları + tutarlılığı doğrular, drill DB'yi
# temizler ve PASS/FAIL + süre (RTO gözlemi) raporlar.
#
# GÜVENLİK (§8 / görev kuralı):
#   • Bu script PROD veritabanına (${POSTGRES_DB}) ASLA yıkıcı komut çalıştırmaz.
#     Tüm DROP/CREATE/RESTORE işlemleri yalnız "*_drill" hedefinde döner; script
#     başındaki guard bunu zorlar (hedef "_drill" ile bitmiyorsa çıkar).
#   • Sırlar (DB parolası) LOGLANMAZ: PGPASSWORD ortamdan geçirilir, argv'ye
#     yazılmaz; `set -x` KULLANILMAZ.
#   • MASTER_KEY (payload çözme anahtarı) bu yedeğin İÇİNDE DEĞİLDİR ve olmamalı —
#     §8 gereği DB yedeğinden AYRI saklanır. Yedek tek başına payload'ı çözemez.
#     Ayrıntı: docs/RUNBOOK-DR.md.
#
# ÇALIŞTIRMA MODLARI:
#   docker (varsayılan) — komutlar `docker exec <postgres-container>` ile koşar.
#   local              — PG_HOST verilirse doğrudan host psql/pg_dump/pg_restore
#                        (docker olmadan). PG_* değişkenleriyle tam override.
#
# PARAMETRELER (hepsi ENV ile override edilebilir — varsayılanlar compose'tan):
#   POSTGRES_CONTAINER   docker mod container adı  (vars: lisans-yonetim-paneli-postgres-1)
#   POSTGRES_USER / DB   DB kullanıcı / ad          (vars: lisanspanel / lisanspanel)
#   POSTGRES_PASSWORD    DB parolası (loglanmaz)
#   PG_HOST/PG_PORT      set edilirse → local mod (docker'sız)
#   PG_USER/PG_DB/PG_PASSWORD   local mod override (yoksa POSTGRES_* kullanılır)
#   PG_MAINT_DB          admin (CREATE/DROP DATABASE) için bağlanılan db (vars: postgres)
#   BACKUP_DIR           dump hedef dizini         (vars: <repo>/backups)
#   BACKUP_KEEP_LAST     >0 ise en yeni N dump'ı tut, eskileri sil (vars: 0 = hepsini tut)
#   STRICT_COUNTS        1 ise prod↔drill satır farkı FAIL (vars: 0 = WARN; canlı prod büyür)
#   ENV_FILE             okunacak .env yolu        (vars: <repo>/.env)
#   SKIP_ENV_FILE        1 ise .env okuma
#
# ÇIKIŞ KODU: 0 = PASS, 1 = FAIL / güvenlik guard.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Yol çözümü ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── (Opsiyonel) .env oku — operatörün gerçek değerleri (POSTGRES_USER/DB/PASSWORD).
#    DİKKAT: .env'i `source` ETMEYİZ — MAIL_FROM gibi değerler '<'/'>' içerir ve
#    sourcing bunları yönlendirme sanıp script'i patlatır. Sadece ihtiyacımız olan
#    anahtarları düz metin olarak, SHELL YORUMU OLMADAN çekeriz. Sırlar echo edilmez.
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
ENV_POSTGRES_USER=""
ENV_POSTGRES_DB=""
ENV_POSTGRES_PASSWORD=""
read_env_var() { # $1=key → değeri (çevresel tırnaklar soyulur), eval YOK
  local key="$1" ln val
  ln="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 || true)"
  [[ -z "$ln" ]] && return 0
  val="${ln#*=}"
  val="${val%\"}"; val="${val#\"}"   # çift tırnak
  val="${val%\'}"; val="${val#\'}"   # tek tırnak
  printf '%s' "$val"
}
if [[ "${SKIP_ENV_FILE:-0}" != "1" && -f "$ENV_FILE" ]]; then
  ENV_POSTGRES_USER="$(read_env_var POSTGRES_USER)"
  ENV_POSTGRES_DB="$(read_env_var POSTGRES_DB)"
  ENV_POSTGRES_PASSWORD="$(read_env_var POSTGRES_PASSWORD)"
fi

# ── Etkin bağlantı değerleri ──────────────────────────────────────────────────
#    Precedence: PG_* (açık env)  >  ortamdaki POSTGRES_*  >  .env dosyası  >  varsayılan.
PG_CONTAINER="${POSTGRES_CONTAINER:-lisans-yonetim-paneli-postgres-1}"
DB_USER="${PG_USER:-${POSTGRES_USER:-${ENV_POSTGRES_USER:-lisanspanel}}}"
DB_NAME="${PG_DB:-${POSTGRES_DB:-${ENV_POSTGRES_DB:-lisanspanel}}}"
DB_PASSWORD="${PG_PASSWORD:-${POSTGRES_PASSWORD:-${ENV_POSTGRES_PASSWORD:-}}}"
MAINT_DB="${PG_MAINT_DB:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
BACKUP_KEEP_LAST="${BACKUP_KEEP_LAST:-0}"
STRICT_COUNTS="${STRICT_COUNTS:-0}"

# Mod seçimi: PG_HOST verildiyse local, aksi halde docker.
if [[ -n "${PG_HOST:-}" ]]; then
  MODE="local"
  PG_PORT="${PG_PORT:-5432}"
else
  MODE="docker"
fi

# ── GÜVENLİK GUARD'LARI ───────────────────────────────────────────────────────
if [[ -z "$DB_NAME" ]]; then
  echo "HATA: POSTGRES_DB/PG_DB boş — çıkılıyor." >&2
  exit 1
fi
DRILL_DB="${DB_NAME}_drill"
# Hedef adı MUTLAKA "_drill" ile bitmeli VE prod adına eşit olmamalı.
case "$DRILL_DB" in
  *_drill) : ;;
  *)
    echo "GÜVENLİK: doğrulama DB adı '${DRILL_DB}' '_drill' ile bitmiyor — çıkılıyor." >&2
    exit 1
    ;;
esac
if [[ "$DRILL_DB" == "$DB_NAME" ]]; then
  echo "GÜVENLİK: doğrulama DB adı prod DB adına ('${DB_NAME}') eşit — çıkılıyor." >&2
  exit 1
fi

export PGPASSWORD="$DB_PASSWORD"   # araç argv'sine değil, ortama; loglanmaz.

# ── Komut önekleri (docker vs local) ─────────────────────────────────────────
#    -e PGPASSWORD (değersiz) → mevcut ortamdaki PGPASSWORD'ı forward eder,
#    böylece parola docker argv'sinde görünmez.
if [[ "$MODE" == "docker" ]]; then
  PGX=(docker exec -e PGPASSWORD "$PG_CONTAINER")
  PGX_I=(docker exec -i -e PGPASSWORD "$PG_CONTAINER")
  CONN=(-U "$DB_USER")
else
  PGX=()
  PGX_I=()
  CONN=(-U "$DB_USER" -h "$PG_HOST" -p "$PG_PORT")
fi

# ── Yardımcılar ───────────────────────────────────────────────────────────────
# Tek değer döndüren SELECT (trimlenmiş).  psql -tA: tuples-only, unaligned.
psql_val() { # $1=db  $2=sql
  "${PGX[@]}" psql -v ON_ERROR_STOP=1 "${CONN[@]}" -d "$1" -tA -c "$2"
}
# Yan-etkili SQL (CREATE/DROP DATABASE vb.) maintenance db üzerinde.
psql_admin() { # $1=sql
  "${PGX[@]}" psql -v ON_ERROR_STOP=1 "${CONN[@]}" -d "$MAINT_DB" -c "$1" >/dev/null
}

# ── Temizlik: her çıkışta drill DB'yi düşür (guard'lı — asla prod'a dokunmaz) ──
cleanup() {
  # DRILL_DB guard'dan geçtiği için burada düşürmek güvenli.
  psql_admin "DROP DATABASE IF EXISTS \"$DRILL_DB\" WITH (FORCE);" 2>/dev/null || true
}
trap cleanup EXIT

# ── Raporlama durumu ──────────────────────────────────────────────────────────
FAILS=0
WARNS=0
line() { printf '%s\n' "────────────────────────────────────────────────────────────"; }
ok()   { printf '  [PASS] %s\n' "$1"; }
warn() { printf '  [WARN] %s\n' "$1"; WARNS=$((WARNS+1)); }
bad()  { printf '  [FAIL] %s\n' "$1"; FAILS=$((FAILS+1)); }

DRILL_START=$(date +%s)
TS="$(date +%Y%m%d-%H%M%S)"

line
echo "Jetlisans Yedek Tatbikatı — $(date '+%Y-%m-%d %H:%M:%S %z')"
echo "  Mod           : $MODE${MODE:+ (container=${PG_CONTAINER})}"
echo "  Prod DB       : $DB_NAME   (kullanıcı: $DB_USER)"
echo "  Doğrulama DB  : $DRILL_DB   (tatbikat sonunda düşürülür)"
echo "  Yedek dizini  : $BACKUP_DIR"
line

# ── 1) pg_dump — custom format, zaman-damgalı dosya ──────────────────────────
mkdir -p "$BACKUP_DIR"
DUMP_FILE="$BACKUP_DIR/${DB_NAME}_${TS}.dump"
echo "[1/6] pg_dump (custom format) → $DUMP_FILE"
# -Fc: custom (sıkıştırılmış, pg_restore ile paralel/seçmeli). Stdout host dosyasına.
if ! "${PGX[@]}" pg_dump -Fc --no-owner --no-privileges "${CONN[@]}" -d "$DB_NAME" > "$DUMP_FILE"; then
  bad "pg_dump başarısız."
  echo; echo "SONUÇ: FAIL (yedek alınamadı)."; exit 1
fi
DUMP_BYTES=$(wc -c < "$DUMP_FILE" | tr -d ' ')
if [[ "${DUMP_BYTES:-0}" -gt 0 ]]; then
  ok "Yedek alındı: ${DUMP_BYTES} bayt"
else
  bad "Yedek dosyası boş."
  echo; echo "SONUÇ: FAIL."; exit 1
fi

# ── 2) Arşiv okunabilirliği (pg_restore -l ile TOC listesi) ──────────────────
echo "[2/6] Arşiv bütünlüğü (pg_restore -l)"
TOC_COUNT=0
if TOC_COUNT=$("${PGX_I[@]}" pg_restore -l < "$DUMP_FILE" 2>/dev/null | grep -c ';' || true); then :; fi
if [[ "${TOC_COUNT:-0}" -gt 0 ]]; then
  ok "Arşiv okunabilir (${TOC_COUNT} TOC girdisi)"
else
  bad "Arşiv okunamadı / boş TOC — yedek bozuk olabilir."
fi

# ── 3) Doğrulama DB'sini (yeniden) oluştur ───────────────────────────────────
echo "[3/6] Doğrulama DB hazırlığı: $DRILL_DB"
psql_admin "DROP DATABASE IF EXISTS \"$DRILL_DB\" WITH (FORCE);"
psql_admin "CREATE DATABASE \"$DRILL_DB\";"
ok "Boş $DRILL_DB oluşturuldu"

# ── 4) Geri yükleme (RTO gözlemi burada başlar) ──────────────────────────────
echo "[4/6] pg_restore → $DRILL_DB (RTO ölçümü)"
RESTORE_START=$(date +%s)
RESTORE_RC=0
# --no-owner/--no-privileges: rol farkları sorun çıkarmasın. Uyarılar ölümcül değil;
# gerçek doğrulama (5) satır sayısı + tutarlılıktır.
"${PGX_I[@]}" pg_restore --no-owner --no-privileges -d "$DRILL_DB" < "$DUMP_FILE" \
  > /dev/null 2> "$BACKUP_DIR/.restore_${TS}.log" || RESTORE_RC=$?
RESTORE_END=$(date +%s)
RESTORE_SECS=$((RESTORE_END - RESTORE_START))
if [[ "$RESTORE_RC" -eq 0 ]]; then
  ok "Geri yükleme tamam (${RESTORE_SECS}s)"
else
  warn "pg_restore rc=$RESTORE_RC (uyarılar olabilir; doğrulamayla teyit ediliyor). Log: $BACKUP_DIR/.restore_${TS}.log"
fi

# ── 5) DOĞRULAMA ─────────────────────────────────────────────────────────────
echo "[5/6] Doğrulama"

# 5a) Kritik tablo satır sayıları: prod ↔ drill.
#     Not: prod CANLI olduğundan dump anından sonra artabilir. Fark varsayılan
#     olarak WARN (canlı sürüklenme); STRICT_COUNTS=1 ise FAIL. drill=0 iken
#     prod>0 ise (veri kaybı) HER ZAMAN FAIL.
TABLES=(license_items assignments orders sites)
printf '  %-16s %12s %12s\n' "tablo" "prod" "drill"
for t in "${TABLES[@]}"; do
  P=$(psql_val "$DB_NAME"  "SELECT count(*) FROM \"$t\";" 2>/dev/null || echo "ERR")
  D=$(psql_val "$DRILL_DB" "SELECT count(*) FROM \"$t\";" 2>/dev/null || echo "ERR")
  printf '  %-16s %12s %12s\n' "$t" "$P" "$D"
  if [[ "$P" == "ERR" || "$D" == "ERR" ]]; then
    bad "$t: satır sayısı okunamadı"
    continue
  fi
  if [[ "$D" -eq 0 && "$P" -gt 0 ]]; then
    bad "$t: drill BOŞ ($D) ama prod dolu ($P) — geri yüklemede veri kaybı"
  elif [[ "$P" -eq "$D" ]]; then
    ok "$t: satır sayısı eşit ($P)"
  else
    if [[ "$STRICT_COUNTS" == "1" ]]; then
      bad "$t: prod=$P ≠ drill=$D (STRICT_COUNTS)"
    else
      warn "$t: prod=$P ≠ drill=$D (canlı prod sürüklenmesi — beklenebilir)"
    fi
  fi
done

# 5b) Tutarlılık: çifte-atama = 0.  Tek-kullanımlık (max_uses=1) her license_item
#     için AYAKTA (active/suspended/expired) atama sayısı ≤ 1 olmalı; >1 →
#     atomik SKIP LOCKED atama (§2) delinmiş = aynı key iki kez satılmış.
#     (Prod reconcile.service single_occupancy denetimiyle birebir; restore
#     edilmiş kopya üzerinde doğrulanır.)
DBL=$(psql_val "$DRILL_DB" "
  SELECT count(*) FROM (
    SELECT a.license_item_id
    FROM assignments a
    JOIN license_items li ON li.id = a.license_item_id
    WHERE li.max_uses = 1
      AND a.status IN ('active','suspended','expired')
    GROUP BY a.license_item_id
    HAVING count(*) > 1
  ) x;" 2>/dev/null || echo "ERR")
if [[ "$DBL" == "ERR" ]]; then
  bad "çifte-atama kontrolü çalıştırılamadı"
elif [[ "$DBL" -eq 0 ]]; then
  ok "çifte-atama = 0 (tek-kullanım key başına ≤1 ayakta atama)"
else
  bad "çifte-atama = $DBL license_item birden çok ayakta atamaya bağlı — bütünlük ihlali"
fi

# ── 6) Temizlik + özet ───────────────────────────────────────────────────────
echo "[6/6] Temizlik"
cleanup
trap - EXIT
ok "$DRILL_DB düşürüldü"

# Opsiyonel retention: yalnız bu script'in ürettiği dump'ları buda (guard'lı desen).
if [[ "$BACKUP_KEEP_LAST" -gt 0 ]]; then
  mapfile -t OLD < <(ls -1t "$BACKUP_DIR/${DB_NAME}_"*.dump 2>/dev/null | tail -n +"$((BACKUP_KEEP_LAST+1))")
  for f in "${OLD[@]:-}"; do
    [[ -n "$f" && -f "$f" ]] && rm -f "$f" && echo "  eski yedek silindi: $(basename "$f")"
  done
fi

DRILL_END=$(date +%s)
TOTAL_SECS=$((DRILL_END - DRILL_START))

line
echo "ÖZET"
echo "  Yedek dosyası     : $DUMP_FILE (${DUMP_BYTES} bayt)"
echo "  Geri-yükleme (RTO): ${RESTORE_SECS}s   [§16 hedef: RTO ≤ 2sa = 7200s]"
echo "  Toplam tatbikat   : ${TOTAL_SECS}s"
echo "  Uyarı / Hata      : WARN=$WARNS  FAIL=$FAILS"
line
if [[ "$FAILS" -eq 0 ]]; then
  echo "SONUC: PASS  (docs/RUNBOOK-DR.md aylik kontrol listesine sonucu kaydedin)"
  exit 0
else
  echo "SONUC: FAIL  ($FAILS kritik) — docs/RUNBOOK-DR.md 'Felaket senaryolari' bolumune bakin"
  exit 1
fi
