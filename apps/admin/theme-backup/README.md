# Tema yedeği — `legacy/` (Inter + klasik shadcn-admin kabuğu)

Bu klasör, **shadcnspace uyarlamasından ÖNCEKİ** temanın birebir kopyasıdır.
Kod tabanının geri kalanına dokunulmaz; buradaki dosyalar yalnızca **yedektir**
(build'e girmez, import edilmez).

## Neyin yedeği

| Dosya | Eski temada ne vardı |
| --- | --- |
| `app/globals.css` | `--radius: 0.625rem`, `--font-inter` / `--font-jbmono` bağları |
| `app/layout.tsx` | `Inter` + `JetBrains_Mono` (next/font/google) |
| `components/shell/app-shell.tsx` | Düz (inset olmayan) kabuk, `main` doğrudan `SidebarInset` içinde |
| `components/shell/app-sidebar.tsx` | Sade menü, aktif öğe `bg-sidebar-accent` |
| `components/shell/site-header.tsx` | `bg-background/85 backdrop-blur`, kare arama tetiği |
| `components/ui/sidebar.tsx` | `variant` prop'u vardı ama **inset uygulanmıyordu** |
| `components/ui/card.tsx` | `px-5`, `text-sm` başlık, `shadow-sm` |
| `components/ui/button.tsx` | `rounded-md`, gölgesiz outline/ghost |
| `components/ui/input.tsx` | `rounded-md` |
| `components/ui/table.tsx` | `th` = 10px yükseklik + `uppercase text-[11px] text-muted-foreground` |
| `components/ui/badge.tsx` | (değişmedi — referansta da `rounded-full` tint) |
| `components/ui/page-header.tsx` | `mb-6`, kare ikon rozeti |
| `components/ui/stat-tile.tsx` | `p-4`, ikon sağda kare çip |
| `components/ui/tabs.tsx` / `dialog.tsx` / `sheet.tsx` | eski yarıçap ölçeği |

## Geri yükleme

```bash
bash apps/admin/theme-backup/restore.sh
```

Betik yalnız yukarıdaki 16 dosyayı üzerine yazar. Sonrasında:

```bash
pnpm --filter @lisans/admin typecheck && pnpm --filter @lisans/admin build
```

`git diff` ile ne döndüğünü görebilirsin; beğenmezsen `git checkout -- apps/admin`.

## Uyarı — yedek "canlı" değildir

Bu kopya, alındığı andaki (2026-08-14, shadcnspace uyarlaması öncesi) halidir.
Yeni temada bu dosyalara sonradan eklenen **düzeltmeler burada YOKTUR**; geri
yüklersen o düzeltmeleri de geri almış olursun. Uzun vadede tek doğruluk
kaynağı git geçmişidir (`git log -- apps/admin/app/globals.css`).
