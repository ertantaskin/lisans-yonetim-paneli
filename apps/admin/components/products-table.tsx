'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Clock, Globe, Link2Off, ShieldAlert } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { cn, formatDate, includesTr } from '../lib/utils';
import type { ProductRow } from '../lib/api';
import { productKindLabel, productTypeSummary, fulfillmentPolicyLabel } from '../lib/labels';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ProductEditSheet } from './product-edit-sheet';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

/**
 * Ürün satırı + eşleme boyutu. API `list()` ürün başına AKTİF eşlemelerin site alan adlarını
 * döndürür; alan `lib/api.ts` ProductRow'da tanımlı OLMADIĞI için (o dosya bu partide başka
 * bir işçinin) burada genişletilir. SAVUNMACI: alan gelmezse (api/admin sürüm sapması)
 * "eşleme yok" İDDİA EDİLMEZ — '—' basılır.
 */
export type ProductTableRow = ProductRow & {
  mappedSites?: string[] | null;
  mappingCount?: number | null;
};

/** Eşleme durumu — facet değeri + rozet kararının TEK kaynağı ('unknown' = alan gelmedi). */
function mappingState(row: ProductTableRow): 'mapped' | 'unmapped' | 'unknown' {
  if (!Array.isArray(row.mappedSites)) return 'unknown';
  return row.mappedSites.length > 0 ? 'mapped' : 'unmapped';
}

/** Ürün tasarım gereği mi stoksuz (stoksuz/ön sipariş) — kırmızı 0 gerçek tükenme DEĞİLDİR. */
function isStockless(row: ProductTableRow): boolean {
  return row.stockless === true;
}

/** Satış tarihi henüz gelmemiş mi (ön sipariş penceresi). */
function isPreRelease(row: ProductTableRow): boolean {
  if (!row.releaseAt) return false;
  const t = new Date(row.releaseAt).getTime();
  return Number.isFinite(t) && t > Date.now();
}

const columns: ColumnDef<ProductTableRow>[] = [
  {
    accessorKey: 'name',
    meta: { title: 'Ürün' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Ürün" />,
    cell: ({ row }) => (
      <Link
        href={`/products/${row.original.id}`}
        className="font-medium text-foreground underline-offset-4 hover:underline"
      >
        {row.original.name}
      </Link>
    ),
    // Arama: ürün adı VEYA SKU. Türkçe-duyarlı karşılaştırma (`includesTr`) — ham
    // `toLowerCase()` ile "İşletim"/"IŞIK" gibi kayıtlar aranınca bulunamıyordu.
    filterFn: (row, _id, value) =>
      includesTr(row.original.name, value) || includesTr(row.original.sku, value),
  },
  {
    accessorKey: 'sku',
    meta: { title: 'SKU' },
    header: 'SKU',
    cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{row.original.sku}</span>,
  },
  {
    accessorKey: 'kind',
    meta: { title: 'Tip' },
    header: 'Tip',
    // Stoksuz/ön sipariş NİTELİĞİ tip özetinde hiç yazmıyordu; oysa bu ürünlerde stok 0
    // TASARIM GEREĞİ kalıcıdır (gerçek tükenmeden ayırt edilmeli).
    cell: ({ row }) => {
      const stockless = isStockless(row.original);
      const preRelease = isPreRelease(row.original);
      return (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{productTypeSummary(row.original)}</span>
          {(stockless || preRelease) && (
            <span className="flex flex-wrap items-center gap-1">
              {stockless && (
                <Badge variant="outline" title="Stoksuz / ön sipariş — stok 0 normaldir">
                  Stoksuz / ön sipariş
                </Badge>
              )}
              {preRelease && (
                <Badge
                  variant="neutral"
                  title={`Satış tarihi: ${formatDate(row.original.releaseAt, false)}`}
                >
                  <Clock /> {formatDate(row.original.releaseAt, false)}
                </Badge>
              )}
            </span>
          )}
        </div>
      );
    },
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'fulfillmentPolicy',
    meta: { title: 'Politika' },
    header: 'Politika',
    cell: ({ row }) => (
      <span className="text-muted-foreground">{fulfillmentPolicyLabel(row.original.fulfillmentPolicy)}</span>
    ),
  },
  {
    accessorKey: 'availableStock',
    meta: { title: 'Stok' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Stok" />,
    cell: ({ row }) => {
      const s = row.original.availableStock;
      const threshold = row.original.lowStockThreshold;
      const low = threshold != null && s <= threshold;
      // Stoksuz/ön sipariş üründe 0 BEKLENEN durumdur → kırmızı alarm gösterme (aksi halde
      // stoka göre sıralanan listede tasarım gereği boş ürünler acil tedariklerle karışıyor).
      const byDesign = isStockless(row.original) || isPreRelease(row.original);
      return (
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              'font-medium tabular-nums',
              s > 0 ? 'text-success' : byDesign ? 'text-muted-foreground' : 'text-destructive',
            )}
            title={
              byDesign && s === 0
                ? 'Stoksuz / ön sipariş ürünü — stok 0 tasarım gereğidir'
                : row.original.usageMode === 'multi'
                  ? 'Kalan kapasite (Σ maksimum kullanım − kullanılan)'
                  : 'Satılabilir stok'
            }
          >
            {s}
          </span>
          {/* Tasarım gereği boş üründe "düşük" uyarısı da yanlış alarmdır. */}
          {low && !(byDesign && s === 0) && (
            <span
              className="inline-flex items-center gap-0.5 rounded bg-warning/10 px-1 py-0.5 text-[10px] font-medium text-warning"
              title={`Düşük stok (eşik ${threshold})`}
            >
              <ShieldAlert className="size-3" /> düşük
            </span>
          )}
        </span>
      );
    },
  },
  {
    // Eşleme boyutu (§3): eşlemesi olmayan ürün "Stok 50, yeşil" görünüp HİÇBİR mağazada
    // satılamıyordu; sipariş satırı sessizce 'eşlenmemiş' bekliyordu. Artık listede görünür.
    id: 'mapping',
    accessorFn: (row) => mappingState(row),
    meta: { title: 'Satıldığı siteler' },
    header: 'Satıldığı siteler',
    enableSorting: false,
    cell: ({ row }) => {
      const state = mappingState(row.original);
      if (state === 'unknown') {
        // Alan gelmedi → "eşleme yok" DEME (uydurma değer yerine '—').
        return <span className="text-xs text-muted-foreground">—</span>;
      }
      if (state === 'unmapped') {
        return (
          <Badge variant="warning" title="Hiçbir mağazaya eşlenmemiş — bu ürün satılamaz">
            <Link2Off /> eşleme yok
          </Badge>
        );
      }
      const domains = row.original.mappedSites ?? [];
      const shown = domains.slice(0, 2);
      return (
        <span className="flex flex-wrap items-center gap-1" title={domains.join(', ')}>
          {shown.map((d) => (
            <span
              key={d}
              className="inline-flex max-w-[12rem] items-center gap-1 truncate rounded border border-border bg-card px-1.5 py-0.5 text-xs text-muted-foreground"
            >
              <Globe className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{d}</span>
            </span>
          ))}
          {domains.length > shown.length && (
            <span className="text-xs text-muted-foreground">+{domains.length - shown.length}</span>
          )}
        </span>
      );
    },
    filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
  },
  {
    id: 'actions',
    header: () => <span className="sr-only">Detay</span>,
    enableSorting: false,
    enableHiding: false,
    cell: ({ row }) => (
      <div className="flex items-center justify-end gap-1">
        <ProductEditSheet product={row.original} />
        <Button asChild variant="ghost" size="sm">
          <Link href={`/products/${row.original.id}`}>
            Detay <ArrowRight />
          </Link>
        </Button>
      </div>
    ),
  },
];

export function ProductsTable({ products }: { products: ProductTableRow[] }) {
  // kind + eşleme facet seçenekleri veriden türetilir
  const facets: FacetConfig[] = React.useMemo(() => {
    const out: FacetConfig[] = [];
    const kinds = Array.from(new Set(products.map((p) => p.kind))).sort();
    if (kinds.length > 1) {
      out.push({
        columnId: 'kind',
        title: 'Tip',
        options: kinds.map((k) => ({ label: productKindLabel(k), value: k })),
      });
    }
    // Süzgeç YALNIZ alan gerçekten geldiyse sunulur (aksi halde hepsi 'unknown' olur ve
    // süzgeç "hiç eşlemesiz ürün yok" gibi yanıltıcı bir izlenim üretir).
    const hasMappingInfo = products.some((p) => Array.isArray(p.mappedSites));
    if (hasMappingInfo) {
      out.push({
        columnId: 'mapping',
        title: 'Eşleme',
        options: [
          { label: 'Eşlenmiş', value: 'mapped', icon: Globe },
          { label: 'Eşleme yok', value: 'unmapped', icon: Link2Off },
        ],
      });
    }
    return out;
  }, [products]);

  return (
    <DataTable
      columns={columns}
      data={products}
      searchColumnId="name"
      searchPlaceholder="Ürün adı veya SKU…"
      facets={facets}
      initialSorting={[{ id: 'availableStock', desc: false }]}
      emptyLabel="Ürün yok."
    />
  );
}
