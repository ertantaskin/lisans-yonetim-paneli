'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, Clock, ShieldAlert } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import type { OrderRow } from '../lib/api';
import { StatusBadge } from './ui/badge';
import { Button } from './ui/button';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

const columns: ColumnDef<OrderRow>[] = [
  {
    accessorKey: 'remoteOrderId',
    meta: { title: 'Sipariş No' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Sipariş No" />,
    cell: ({ row }) => <span className="font-medium tabular-nums">{row.original.remoteOrderId}</span>,
    // Arama: sipariş no VEYA müşteri e-postası
    filterFn: (row, _id, value) => {
      const q = String(value).toLowerCase();
      return (
        row.original.remoteOrderId.toLowerCase().includes(q) ||
        row.original.customerEmail.toLowerCase().includes(q)
      );
    },
  },
  {
    accessorKey: 'customerEmail',
    meta: { title: 'Müşteri' },
    header: 'Müşteri',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.customerEmail}</span>,
  },
  {
    accessorKey: 'status',
    meta: { title: 'Durum' },
    header: 'Durum',
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'createdAt',
    meta: { title: 'Tarih' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Tarih" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {new Date(row.original.createdAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })}
      </span>
    ),
    sortingFn: 'datetime',
  },
  {
    id: 'actions',
    cell: ({ row }) => (
      <div className="text-right">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/orders/${row.original.id}`}>
            Detay <ArrowRight />
          </Link>
        </Button>
      </div>
    ),
  },
];

const facets: FacetConfig[] = [
  {
    columnId: 'status',
    title: 'Durum',
    options: [
      { label: 'Bekliyor', value: 'pending', icon: Clock },
      { label: 'Kısmi', value: 'partial', icon: Clock },
      { label: 'Teslim edildi', value: 'fulfilled', icon: CheckCircle2 },
      { label: 'Eşlenmemiş', value: 'unmapped', icon: ShieldAlert },
    ],
  },
];

export function OrdersTable({ orders }: { orders: OrderRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={orders}
      searchColumnId="remoteOrderId"
      searchPlaceholder="Sipariş no veya e-posta…"
      facets={facets}
      initialSorting={[{ id: 'createdAt', desc: true }]}
      emptyLabel="Kayıt yok."
    />
  );
}
