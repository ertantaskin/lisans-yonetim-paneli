'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { cn } from '../lib/utils';
import type { ProductRow } from '../lib/api';
import { Button } from './ui/button';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

/** Ürün tip etiketi: kind + (multi ise) kapasite + geçerlilik. */
function typeLabel(p: ProductRow): string {
  const parts = [p.kind];
  if (p.usageMode === 'multi') parts.push(`MAK×${p.maxUses ?? '?'}`);
  if (p.validityDays) parts.push(`${p.validityDays}g`);
  return parts.join(' · ');
}

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
    cell: ({ row }) => <span className="text-xs text-muted-foreground">{typeLabel(row.original)}</span>,
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'fulfillmentPolicy',
    meta: { title: 'Politika' },
    header: 'Politika',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.fulfillmentPolicy}</span>,
  },
  {
    accessorKey: 'availableStock',
    meta: { title: 'Stok' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Stok" />,
    cell: ({ row }) => {
      const s = row.original.availableStock;
      return (
        <span
          className={cn('font-medium tabular-nums', s > 0 ? 'text-success' : 'text-destructive')}
          title={
            row.original.usageMode === 'multi'
              ? 'kalan kapasite (Σ max-kullanım − kullanılan)'
              : 'available satır'
          }
        >
          {s}
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
      <div className="text-right">
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
      ? [{ columnId: 'kind', title: 'Tip', options: kinds.map((k) => ({ label: k, value: k })) }]
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
