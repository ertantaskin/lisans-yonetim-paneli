#!/usr/bin/env bash
# Admin rota duman testi — ÇALIŞMA ANI hatalarını yakalar.
#
# NEDEN VAR: `tsc` ve `next build` bazı kırılmaları GÖRMEZ, ekran ancak açılınca patlar:
#   · sunucu bileşeninden istemci bileşenine FONKSİYON prop'u geçmek
#     ("Functions cannot be passed directly to Client Components") — 2026-08-13'te
#     /suppliers'ı hata sınırına düşürdü, build tertemizdi.
#   · 'use server' dosyasından obje/sabit export etmek (bunun için ayrıca check-use-server.js var)
#   · yalnız veriyle ortaya çıkan render hataları
#
# ÖNEMLİ: yalnız HTTP kodu bakmak YETMEZ — Next hata sınırı 200 döner. Bu yüzden gövdede
# error.tsx'in imzasını ("Hata kodu:" + "Tekrar dene") arıyoruz. Daha önceki elle taramam
# yalnız "Sayfa yüklenemedi" gibi metinlere baktığı için kırık /suppliers'ı TEMİZ raporlamıştı.
#
# Kullanım:  ./scripts/smoke-routes.sh [taban-url]        (varsayılan http://127.0.0.1:3006)
set -uo pipefail

BASE="${1:-http://127.0.0.1:3006}"

# NOT: yeni bir sayfa (app/<rota>/page.tsx) eklendiğinde BURAYA da eklenmeli — betiğin tüm
# değeri kapsamında. `categories` ilk turda unutulmuştu (kategori ekranı eklendiği hâlde hiç
# taranmıyordu); `sites/new` (onboarding sihirbazı) ve `templates/new` de aynı şekilde
# listeye hiç girmemişti — ikisi de sunucu action'ı olan, yani çalışma anında kırılabilen
# sayfalar. `login` bilinçli dışarıda (kimlik doğrulama akışı, hata sınırı testi değil);
# `/` de dışarıda (middleware yönlendirmesi, kendi sayfası yok).
#
# KAPSAM DENETİMİ (elle): aşağıdaki liste app/ ağacıyla karşılaştırılabilir —
#   find apps/admin/app -name page.tsx | sed 's|.*app/||; s|/page.tsx$||' | grep -v '\[' | sort
ROUTES=(
  dashboard pending review orders stock stock/import categories mappings quarantine quarantine/claims quarantine/records sites
  sites/new suppliers purchase-orders batches support customers reports reports/costs reports/sla reports/reorder ai notifications
  ops security audit admins admins/security templates templates/new releases deployments settings guide products
)

fail=0
printf '%-22s %-6s %s\n' 'ROTA' 'KOD' 'DURUM'
for r in "${ROUTES[@]}"; do
  body="$(curl -sL -w $'\n%{http_code}' "$BASE/$r" 2>/dev/null)"
  code="$(printf '%s' "$body" | tail -n1)"
  html="$(printf '%s' "$body" | sed '$d')"

  state='tamam'
  if [ "$code" != "200" ]; then
    state="HTTP $code"
    fail=1
  elif printf '%s' "$html" | grep -q 'Hata kodu:' && printf '%s' "$html" | grep -q 'Tekrar dene'; then
    # digest'i de yazdır: sunucu logunda aynı numarayla aranır.
    digest="$(printf '%s' "$html" | grep -o 'Hata kodu: [0-9]*' | head -n1)"
    state="HATA SINIRI ($digest)"
    fail=1
  fi
  printf '%-22s %-6s %s\n' "/$r" "$code" "$state"
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "✗ En az bir rota kırık. Sunucu logunda hata kodunu arayın:"
  echo "  docker logs <admin-konteyner> --since 10m | grep -A5 '<digest>'"
  exit 1
fi
echo
echo "✓ Tüm rotalar açıldı, hata sınırına düşen yok."
