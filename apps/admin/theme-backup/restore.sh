#!/usr/bin/env bash
# Eski temayı (Inter + klasik shadcn-admin kabuğu) geri yükler.
#
# ⚠ BU YEDEK ARTIK GÜVENLE GERİ YÜKLENEMEZ — TARİHÎ ANLIK GÖRÜNTÜDÜR.
#
# Yedek alındıktan sonra tema dili esaslı biçimde değişti: durum renkleri BEŞ hue'ya çıktı ve
# rozet/uyarı/StatTile yüzeyleri artık `--<hue>-vivid` / `--<hue>-fill` / `--<hue>-ring`
# token'larından besleniyor. ÖLÇÜLDÜ: `legacy/app/globals.css` bu token'ların HİÇBİRİNİ
# tanımlamıyor (`--success-vivid` → yedekte 0, güncelde 6 kez). Yani geri yükleme sessizce
# renksiz/eksik bir arayüz bırakır — "tek komutta eski temaya dön" sözü bugün TUTMUYOR.
#
# Eski hâle dönmek gerekiyorsa doğru araç git'tir (dosyalar geçmişte duruyor):
#   git log --oneline -- apps/admin/app/globals.css
#   git checkout <sha> -- apps/admin/app/globals.css apps/admin/components/shell
#
# Yine de bu betiği çalıştırmak istiyorsan bilerek onayla:
#   THEME_RESTORE_ONAY=1 bash apps/admin/theme-backup/restore.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
admin="$(cd "$here/.." && pwd)"
src="$here/legacy"

if [ -z "${THEME_RESTORE_ONAY:-}" ]; then
  echo "DURDURULDU: bu yedek güncel tema token'larını (--*-vivid/--*-fill) taşımıyor;" >&2
  echo "geri yükleme renksiz/eksik bir arayüz bırakır. Gerekçe ve doğru yöntem için" >&2
  echo "betiğin başındaki nota bak. Bilerek devam: THEME_RESTORE_ONAY=1 $0" >&2
  exit 1
fi

[ -d "$src" ] || { echo "HATA: yedek klasörü yok: $src" >&2; exit 1; }

count=0
while IFS= read -r f; do
  rel="${f#$src/}"
  mkdir -p "$admin/$(dirname "$rel")"
  cp "$f" "$admin/$rel"
  echo "  geri yüklendi: apps/admin/$rel"
  count=$((count + 1))
done < <(find "$src" -type f)

echo
echo "$count dosya geri yüklendi."
echo "Şimdi: pnpm --filter @lisans/admin typecheck && pnpm --filter @lisans/admin build"
