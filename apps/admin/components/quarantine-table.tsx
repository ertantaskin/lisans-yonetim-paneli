'use client';
import * as React from 'react';
import Link from 'next/link';
import { Ban, ShieldAlert } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import type { QuarantineRow } from '../lib/api';
import { fmtDateTime } from '../lib/utils';
import { productKindLabel } from '../lib/labels';
import { StatusBadge } from './ui/badge';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

const columns: ColumnDef<QuarantineRow>[] = [
  {
    accessorKey: 'productName',
    meta: { title: 'Ürün' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Ürün" />,
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="font-medium">{row.original.productName}</span>
        <span className="text-xs text-muted-foreground">
          {productKindLabel(row.original.productKind)}
        </span>
      </div>
    ),
  },
  {
    accessorKey: 'status',
    meta: { title: 'Durum' },
    header: 'Durum',
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'keyPreview',
    meta: { title: 'Anahtar' },
    header: 'Anahtar',
    enableSorting: false,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">{row.original.keyPreview}</span>
    ),
  },
  {
    accessorKey: 'sourceRemoteOrderId',
    meta: { title: 'Kaynak sipariş' },
    header: 'Kaynak sipariş',
    cell: ({ row }) =>
      row.original.sourceOrderId ? (
        <Link
          href={`/orders/${row.original.sourceOrderId}`}
          className="font-medium tabular-nums text-foreground underline-offset-4 hover:underline"
          aria-label={`Kaynak sipariş ${row.original.sourceRemoteOrderId ?? ''} detayına git`}
        >
          {row.original.sourceRemoteOrderId ?? '—'}
        </Link>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    accessorKey: 'customerEmail',
    meta: { title: 'Müşteri' },
    header: 'Müşteri',
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.customerEmail ?? '—'}</span>
    ),
  },
  {
    accessorKey: 'reason',
    meta: { title: 'Sebep' },
    header: 'Sebep',
    enableSorting: false,
    cell: ({ row }) => (
      <span className="block max-w-[16rem] truncate text-muted-foreground" title={row.original.reason ?? undefined}>
        {row.original.reason ?? '—'}
      </span>
    ),
  },
  {
    accessorKey: 'quarantinedAt',
    meta: { title: 'Tarih' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Tarih" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {row.original.quarantinedAt ? fmtDateTime(row.original.quarantinedAt) : '—'}
      </span>
    ),
    sortingFn: 'datetime',
  },
];

const facets: FacetConfig[] = [
  {
    columnId: 'status',
    title: 'Durum',
    options: [
      { label: 'Karantina', value: 'quarantined', icon: ShieldAlert },
      { label: 'Geçersiz', value: 'voided', icon: Ban },
    ],
  },
];

export function QuarantineTable({ rows }: { rows: QuarantineRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={rows}
      searchColumnId="productName"
      searchPlaceholder="Ürün adı ara…"
      facets={facets}
      initialSorting={[{ id: 'quarantinedAt', desc: true }]}
      emptyLabel="Karantinada anahtar yok."
    />
  );
}
