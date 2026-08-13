#!/usr/bin/env bash
# Eski temayı (Inter + klasik shadcn-admin kabuğu) geri yükler.
# Kullanım:  bash apps/admin/theme-backup/restore.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
admin="$(cd "$here/.." && pwd)"
src="$here/legacy"

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
