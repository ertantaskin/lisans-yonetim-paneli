'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Ban, CheckCircle2, Clock, ShieldAlert } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import type { OrderRow } from '../lib/api';
import { fmtDateTime, includesTr } from '../lib/utils';
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
    // Arama: sipariş no VEYA müşteri e-postası VEYA mağaza. Türkçe-duyarlı karşılaştırma
    // (`includesTr`): ham `toLowerCase()` ile "İ"/"I" içeren e-postalar bulunamıyordu.
    filterFn: (row, _id, value) =>
      includesTr(row.original.remoteOrderId, value) ||
      includesTr(row.original.customerEmail, value) ||
      includesTr(row.original.siteDomain ?? '', value),
  },
  {
    // ÇOK SİTELİ BAĞLAM: hangi mağazadan geldiği (operatör şikâyeti). Facet ile filtrelenebilir.
    // `accessorFn` — alan API'den gelmezse (sürüm sapması) '—' basılır, satır yine listelenir.
    id: 'siteDomain',
    accessorFn: (row) => row.siteDomain ?? '',
    meta: { title: 'Mağaza' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Mağaza" />,
    cell: ({ row }) =>
      row.original.siteDomain ? (
        <span className="whitespace-nowrap">{row.original.siteDomain}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
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
        {fmtDateTime(row.original.createdAt)}
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

const statusFacet: FacetConfig = {
  columnId: 'status',
  title: 'Durum',
  options: [
    { label: 'Bekliyor', value: 'pending', icon: Clock },
    { label: 'Kısmi', value: 'partial', icon: Clock },
    { label: 'Teslim edildi', value: 'fulfilled', icon: CheckCircle2 },
    { label: 'Geri alındı', value: 'revoked', icon: Ban },
    { label: 'Eşlenmemiş', value: 'unmapped', icon: ShieldAlert },
  ],
};

export function OrdersTable({ orders }: { orders: OrderRow[] }) {
  // Mağaza facet'i VERİDEN türetilir (sabit liste değil): yalnız gerçekten sipariş gelmiş
  // mağazalar listelenir. TEK mağaza varsa facet GÖSTERİLMEZ — tek seçenekli filtre gürültüdür.
  const facets = React.useMemo<FacetConfig[]>(() => {
    const domains = Array.from(
      new Set(orders.map((o) => o.siteDomain).filter((d): d is string => !!d)),
    ).sort((a, b) => a.localeCompare(b, 'tr'));
    return domains.length > 1
      ? [
          statusFacet,
          {
            columnId: 'siteDomain',
            title: 'Mağaza',
            options: domains.map((d) => ({ label: d, value: d })),
          },
        ]
      : [statusFacet];
  }, [orders]);

  return (
    <DataTable
      columns={columns}
      data={orders}
      searchColumnId="remoteOrderId"
      searchPlaceholder="Sipariş no, e-posta veya mağaza…"
      facets={facets}
      initialSorting={[{ id: 'createdAt', desc: true }]}
      emptyLabel="Kayıt yok."
    />
  );
}
