'use client';
import Link from 'next/link';
import * as React from 'react';
import { ArrowRight } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import type { PurchaseOrderRow } from '@/app/purchase-orders/queries';
import { Badge, type BadgeProps } from './ui/badge';
import { Button } from './ui/button';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

/** PO durum → renk/etiket (§12). Sipariş durum dilinden ayrı, tedarik akışına özel. */
const PO_STATUS: Record<string, { variant: NonNullable<BadgeProps['variant']>; label: string }> = {
  draft: { variant: 'outline', label: 'taslak' },
  ordered: { variant: 'neutral', label: 'sipariş verildi' },
  partial: { variant: 'warning', label: 'kısmi teslim' },
  received: { variant: 'success', label: 'teslim alındı' },
  cancelled: { variant: 'danger', label: 'iptal' },
};

export function POStatusBadge({ status, className }: { status: string; className?: string }) {
  const meta = PO_STATUS[status] ?? { variant: 'neutral' as const, label: status };
  return (
    <Badge variant={meta.variant} className={className}>
      {meta.label}
    </Badge>
  );
}

/** ISO tarihi kısa tr-TR biçimler. */
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('tr-TR', { dateStyle: 'short' });
}

const columns: ColumnDef<PurchaseOrderRow>[] = [
  {
    accessorKey: 'supplierName',
    meta: { title: 'Tedarikçi' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Tedarikçi" />,
    cell: ({ row }) => <span className="font-medium">{row.original.supplierName}</span>,
    filterFn: (row, _id, value) => {
      const q = String(value).toLowerCase();
      return (
        row.original.supplierName.toLowerCase().includes(q) ||
        row.original.productSku.toLowerCase().includes(q) ||
        row.original.productName.toLowerCase().includes(q)
      );
    },
  },
  {
    id: 'product',
    accessorFn: (r) => `${r.productSku} ${r.productName}`,
    meta: { title: 'Ürün' },
    header: 'Ürün',
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        <span className="font-mono text-xs text-foreground/70">{row.original.productSku}</span>{' '}
        {row.original.productName}
      </span>
    ),
    enableSorting: false,
  },
  {
    accessorKey: 'status',
    meta: { title: 'Durum' },
    header: 'Durum',
    cell: ({ row }) => <POStatusBadge status={row.original.status} />,
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    id: 'qty',
    meta: { title: 'Teslim' },
    header: 'Teslim',
    accessorFn: (r) => r.qtyReceived,
    cell: ({ row }) => (
      <span className="tabular-nums">
        {row.original.qtyReceived}/{row.original.qtyOrdered}
      </span>
    ),
  },
  {
    accessorKey: 'eta',
    meta: { title: 'ETA' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="ETA" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">{fmtDate(row.original.eta)}</span>
    ),
    sortingFn: 'datetime',
  },
  {
    id: 'actions',
    header: () => <span className="sr-only">Aksiyonlar</span>,
    cell: ({ row }) => (
      <div className="text-right">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/purchase-orders/${row.original.id}`}>
            Detay <ArrowRight />
          </Link>
        </Button>
      </div>
    ),
    enableSorting: false,
    enableHiding: false,
  },
];

const facets: FacetConfig[] = [
  {
    columnId: 'status',
    title: 'Durum',
    options: [
      { label: 'Taslak', value: 'draft' },
      { label: 'Sipariş verildi', value: 'ordered' },
      { label: 'Kısmi teslim', value: 'partial' },
      { label: 'Teslim alındı', value: 'received' },
      { label: 'İptal', value: 'cancelled' },
    ],
  },
];

export function PurchaseOrdersTable({ orders }: { orders: PurchaseOrderRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={orders}
      searchColumnId="supplierName"
      searchPlaceholder="Tedarikçi veya ürün ara…"
      facets={facets}
      initialSorting={[{ id: 'eta', desc: false }]}
      emptyLabel="Henüz satın alma emri yok."
    />
  );
}
