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
# Admin runtime probu — GERÇEKTEN RENDER EDEN bir rota (denetim A2).
#
# ESKİDEN kök `/` idi ve prob HİÇBİR React bileşeni çalıştırmıyordu: `apps/admin/middleware.ts`
# kök yolu RENDER'DAN ÖNCE 307 ile `/pending`'e yönlendiriyor; curl `-L` taşımadığı ve
# [200,500) aralığı kabul edildiği için prob o 307'yi görüp "sağlıklı" diyordu. Sonuç: kök
# layout ya da herhangi bir sayfa render'da patlasa bile dağıtım BAŞARILI sayılıyor ve
# otomatik geri alma TETİKLENMİYORDU — yani admin sağlık kapısı fiilen boştu.
#
# ARTIK `/pending` (auth kapalıyken gerçek ekran; auth AÇIKKEN `-L` ile `/login`'e izlenir —
# o da gerçek bir render'dır ve kök layout'u çalıştırır). Her iki durumda da Next sunucu
# runtime'ı + kök layout GERÇEKTEN koşar.
ADMIN_HEALTH_URL="${ADMIN_HEALTH_URL:-https://admin.167-233-108-12.sslip.io/pending}"
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

# Admin runtime probu. Son sağlıksızlık sebebi burada tutulur → rollback mesajı "neden"i söyler
# (prob bir döngüde 30 kez koştuğu için her denemede log basmak gürültü olurdu).
ADMIN_FAIL_REASON=''

# Admin sağlıklı mı? ÜÇ koşul birlikte:
#   1) `-L` ile yönlendirmeler İZLENİR → prob bir middleware 307'sinde durup "tamam" demez
#      (A2'nin kök nedeni tam olarak buydu).
#   2) Nihai HTTP kodu [200,500): 2xx/3xx/4xx runtime ayakta demektir (auth AÇIKKEN /login
#      ekranı 200 döner; REQUIRE_AUTH yanlış yapılandırmasının 503'ü ise BURADA yakalanır).
#      5xx / bağlantı yok = sağlıksız.
#   3) YALNIZ HTTP KODUNA BAKMAK YETMEZ: Next hata sınırı (error.tsx) sayfa render'da
#      patladığında da **200** döner. Bu yüzden gövdede hata sınırının imzası aranır
#      ("Hata kodu:" + "Tekrar dene") — desen `scripts/smoke-routes.sh` ile BİREBİR aynı
#      (iki yerde ayrışırsa biri kırığı temiz raporlar; aynı tutulmalı).
#      NOT (bilinen sınır, smoke-routes.sh ile ORTAK): `ErrorState` "Hata kodu:" satırını
#      yalnız `error.digest` varken basar. Sunucuda üretilen hatalarda Next digest'i her
#      zaman koyar (probumuz JS çalıştırmayan düz bir HTTP isteğidir, yani yalnız SSR
#      sınırlarını görür) → pratikte kapsanır. Yine de bu iki ifadeden biri değişirse İKİ
#      betik BİRLİKTE güncellenmelidir.
admin_health(){
  local body code html digest
  ADMIN_FAIL_REASON=''
  # -L: yönlendirmeleri izle. Gövde + nihai kod tek çağrıda alınır (son satır = kod).
  body="$(curl -sL -w $'\n%{http_code}' --max-time 15 "$ADMIN_HEALTH_URL" 2>/dev/null)" || body=$'\n000'
  code="$(printf '%s' "$body" | tail -n1)"
  html="$(printf '%s' "$body" | sed '$d')"

  case "$code" in ''|*[!0-9]*) ADMIN_FAIL_REASON="yanıt yok/geçersiz kod"; return 1;; esac
  # curl bağlanamazsa %{http_code} '000' basar → "HTTP 000" yerine anlaşılır sebep yaz.
  if [ "$code" -eq 0 ]; then
    ADMIN_FAIL_REASON="bağlantı kurulamadı (TLS/DNS/konteyner ayakta değil)"
    return 1
  fi
  if [ "$code" -lt 200 ] || [ "$code" -ge 500 ]; then
    ADMIN_FAIL_REASON="HTTP $code"
    return 1
  fi
  if printf '%s' "$html" | grep -q 'Hata kodu:' && printf '%s' "$html" | grep -q 'Tekrar dene'; then
    # `|| true` ŞART: bu betik `set -e` ile koşuyor (smoke-routes.sh koşmuyor). digest
    # beklenmedik bir biçimdeyse grep 1 döner, atama başarısız olur ve set -e dağıtımı
    # TAM DA teşhis satırını yazarken öldürürdü — teşhis, dağıtımı düşürme sebebi olamaz.
    digest="$(printf '%s' "$html" | grep -o 'Hata kodu: [0-9]*' | head -n1 || true)"
    ADMIN_FAIL_REASON="HTTP $code ama Next HATA SINIRI render edildi (${digest:-digest yok})"
    return 1
  fi
  return 0
}
# Dağıtılan TÜM hedefler sağlıklı mı: API her zaman; admin yalnız SERVICES'te varsa.
all_healthy(){
  # Sebep her turda SIFIRLANIR: API sağlıksızsa admin probu HİÇ koşmaz; sıfırlanmasa bir
  # önceki turdan kalan admin sebebi basılır ve teşhis yanlış yöne gider.
  ADMIN_FAIL_REASON=''
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
  # YALNIZ başarılı dağıtımdan SONRA ve YALNIZ dangling/eski önbellek: ÇALIŞAN konteynerlerin
  # imajları etkilenmez (`-a` KULLANILMAZ). Hata olursa dağıtımı BAŞARISIZ sayma (temizlik
  # kritik değil) → `|| true`.
  #
  # DÜZELTME (denetim O10): burada eskiden "rollback için gereken ÖNCEKİ imaj etkilenmez"
  # yazıyordu — YANLIŞ. Yeniden build'den sonra önceki imaj etiketsiz (dangling) kalır ve
  # `docker image prune -f` tam da onu siler. İşlevsel etkisi YOK, çünkü rollback bu imajı
  # KULLANMAZ: `git reset --hard <sha>` + yeniden build ile KAYNAKTAN döner. Yorum, olmayan
  # bir güvenceyi vaat ettiği için düzeltildi (yanlış güven, eksik güvenceden tehlikelidir).
  say "Disk temizliği (dangling imaj + 7 günden eski build cache)…"
  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -f --filter 'until=168h' >/dev/null 2>&1 || true
  ok "Temizlik bitti. Kalan disk: $(df -h / | awk 'NR==2{print $4" boş ("$5" dolu)"}')"

  say "docs/DEPLOY-LOG.md'ye satır eklemeyi unutma (görünür geçmiş)."
else
  # Sebebi YAZ: admin probu artık "200 ama hata sınırı" gibi ayrımlar da yapıyor; sebep
  # basılmazsa operatör 5xx ile render çöküşünü ayırt edemez (log/panel yalnız bu satırı görür).
  if [ -n "$ADMIN_FAIL_REASON" ]; then
    err "SAĞLIK BAŞARISIZ ($NEW). Admin probu: $ADMIN_FAIL_REASON ($ADMIN_HEALTH_URL)"
  else
    err "SAĞLIK BAŞARISIZ ($NEW). API sağlık ucu 'ok' vermedi ($HEALTH_URL)"
  fi
  rollback
fi
