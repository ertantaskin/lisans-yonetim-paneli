import Link from 'next/link';
import { ArrowRight, Boxes, FolderOpen, PackageX } from 'lucide-react';
import { UNCATEGORIZED, type CategoryRow } from '../lib/categories';
import { Badge } from './ui/badge';

/**
 * `/stock` giriş seviyesi: KATEGORİ kartları (kullanıcı geri bildirimi: "panel ürünleri
 * direkt görünüyor, karışıklığı gidermek için kategorize edelim; kart tarzı daha kullanışlı").
 *
 * Kart üç bilgi taşır ve üçü de operatörün "bugün nereye bakmalıyım" sorusunu yanıtlar:
 * ürün sayısı (grubun büyüklüğü) · atanabilir stok (satılabilir kapasite) · düşük stok
 * uyarısı (eşik altına düşmüş ürün). Düşük stok VARSA kart uyarı tonuna döner — alarm
 * kartın içine girmeden görünür.
 *
 * "Kategorisiz" kartı gerçek bir kategori DEĞİLDİR (id='none'): kategori atanmamış ürünler
 * ekrandan kaybolmasın diye vardır. Yalnız içinde ürün varken çizilir.
 */
export function CategoryGrid({ categories }: { categories: CategoryRow[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {categories.map((c) => {
        const uncategorized = c.id === UNCATEGORIZED;
        const hasLowStock = c.lowStockCount > 0;
        return (
          <Link
            key={c.id}
            href={`/stock?category=${encodeURIComponent(c.id)}`}
            className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-xs outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                  <FolderOpen className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground" title={c.name}>
                    {c.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {uncategorized
                      ? 'Kategori atanmamış ürünler'
                      : (c.description ?? `${c.productCount} ürün`)}
                  </p>
                </div>
              </div>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Boxes className="size-3.5" />
                <strong className="text-sm font-semibold tabular-nums text-foreground">
                  {c.productCount.toLocaleString('tr-TR')}
                </strong>
                ürün
              </span>
              <span className="inline-flex items-center gap-1.5">
                <strong className="text-sm font-semibold tabular-nums text-foreground">
                  {c.availableStock.toLocaleString('tr-TR')}
                </strong>
                atanabilir stok
              </span>
              {hasLowStock && (
                <Badge variant="warning">
                  <PackageX />
                  {c.lowStockCount} üründe stok azaldı
                </Badge>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
