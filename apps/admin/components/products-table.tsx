'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, ShieldAlert } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { cn } from '../lib/utils';
import type { ProductRow } from '../lib/api';
import { productKindLabel, productTypeSummary, fulfillmentPolicyLabel } from '../lib/labels';
import { Button } from './ui/button';
import { ProductEditSheet } from './product-edit-sheet';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

const columns: ColumnDef<ProductRow>[] = [
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
    filterFn: (row, _id, value) => {
      const q = String(value).toLowerCase();
      return (
        row.original.name.toLowerCase().includes(q) || row.original.sku.toLowerCase().includes(q)
      );
    },
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
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">{productTypeSummary(row.original)}</span>
    ),
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
      return (
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn('font-medium tabular-nums', s > 0 ? 'text-success' : 'text-destructive')}
            title={
              row.original.usageMode === 'multi'
                ? 'Kalan kapasite (Σ maksimum kullanım − kullanılan)'
                : 'Satılabilir stok'
            }
          >
            {s}
          </span>
          {low && (
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

export function ProductsTable({ products }: { products: ProductRow[] }) {
  // kind facet seçenekleri veriden türetilir
  const facets: FacetConfig[] = React.useMemo(() => {
    const kinds = Array.from(new Set(products.map((p) => p.kind))).sort();
    return kinds.length > 1
      ? [
          {
            columnId: 'kind',
            title: 'Tip',
            options: kinds.map((k) => ({ label: productKindLabel(k), value: k })),
          },
        ]
      : [];
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
