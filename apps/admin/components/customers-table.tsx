'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Globe, ShieldAlert } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import type { CustomerRow } from '../app/customers/queries';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';

/** Değişim oranı bu eşiği aşarsa suistimal işareti (warning). */
const ABUSE_THRESHOLD = 0.3;

/** 0..1 oranı yüzde metnine çevirir. */
function ratePct(rate: number): string {
  return `%${Math.round(rate * 100)}`;
}

const emailColumn: ColumnDef<CustomerRow> = {
  accessorKey: 'email',
  meta: { title: 'Müşteri' },
  header: ({ column }) => <DataTableColumnHeader column={column} title="Müşteri" />,
  cell: ({ row }) => (
    <Link
      href={`/customers/${encodeURIComponent(row.original.email)}`}
      className="font-medium text-foreground underline-offset-4 hover:underline"
    >
      {row.original.email}
    </Link>
  ),
  filterFn: 'includesString',
};

/** Site kolonu — yalnız global (site-süzgeçsiz) görünümde gösterilir. */
const sitesColumn: ColumnDef<CustomerRow> = {
  id: 'sites',
  accessorFn: (row) => (row.sites ?? []).join(' '),
  meta: { title: 'Siteler' },
  header: 'Siteler',
  enableSorting: false,
  cell: ({ row }) => {
    const sites = row.original.sites ?? [];
    if (!sites.length) return <span className="text-muted-foreground">—</span>;
    return (
      <div className="flex flex-wrap gap-1">
        {sites.map((s) => (
          <Badge key={s} variant="outline">
            <Globe />
            {s}
          </Badge>
        ))}
      </div>
    );
  },
};

const restColumns: ColumnDef<CustomerRow>[] = [
  {
    accessorKey: 'orderCount',
    meta: { title: 'Sipariş' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Sipariş" />,
    cell: ({ row }) => <span className="tabular-nums">{row.original.orderCount}</span>,
  },
  {
    accessorKey: 'assignmentCount',
    meta: { title: 'Atama' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Atama" />,
    cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.assignmentCount}</span>,
  },
  {
    accessorKey: 'replacementCount',
    meta: { title: 'Değişim' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Değişim" />,
    cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.replacementCount}</span>,
  },
  {
    accessorKey: 'replacementRate',
    meta: { title: 'Değişim Oranı' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Değişim Oranı" />,
    cell: ({ row }) => {
      const rate = row.original.replacementRate;
      // Eşiği aşan oran → suistimal işareti (warning rozeti)
      if (rate > ABUSE_THRESHOLD) {
        return (
          <Badge variant="warning">
            <ShieldAlert />
            {ratePct(rate)}
          </Badge>
        );
      }
      return <span className="tabular-nums text-muted-foreground">{ratePct(rate)}</span>;
    },
    sortingFn: 'basic',
  },
  {
    accessorKey: 'tags',
    meta: { title: 'Etiketler' },
    header: 'Etiketler',
    enableSorting: false,
    cell: ({ row }) => {
      const tags = row.original.tags;
      if (!tags.length) return <span className="text-muted-foreground">—</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {tags.map((t) => (
            <Badge key={t} variant="outline">
              {t}
            </Badge>
          ))}
        </div>
      );
    },
  },
  {
    accessorKey: 'lastOrderAt',
    meta: { title: 'Son Sipariş' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Son Sipariş" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {row.original.lastOrderAt
          ? new Date(row.original.lastOrderAt).toLocaleDateString('tr-TR', { dateStyle: 'short' })
          : '—'}
      </span>
    ),
    sortingFn: 'datetime',
  },
  {
    id: 'actions',
    header: () => <span className="sr-only">Detay</span>,
    enableSorting: false,
    enableHiding: false,
    cell: ({ row }) => (
      <div className="text-right">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/customers/${encodeURIComponent(row.original.email)}`}>
            Detay <ArrowRight />
          </Link>
        </Button>
      </div>
    ),
  },
];

export function CustomersTable({
  customers,
  siteScoped = false,
}: {
  customers: CustomerRow[];
  /** Tek siteye süzülmüşse "Siteler" kolonu gereksiz → gizle. */
  siteScoped?: boolean;
}) {
  const columns = React.useMemo<ColumnDef<CustomerRow>[]>(
    () => [emailColumn, ...(siteScoped ? [] : [sitesColumn]), ...restColumns],
    [siteScoped],
  );
  return (
    <DataTable
      columns={columns}
      data={customers}
      searchColumnId="email"
      searchPlaceholder="E-posta ara…"
      initialSorting={[{ id: 'lastOrderAt', desc: true }]}
      emptyLabel={siteScoped ? 'Bu sitenin müşterisi yok.' : 'Henüz müşteri yok.'}
    />
  );
}
