'use client';
import * as React from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import type { SiteRow } from '../lib/api';
import { StatusBadge } from './ui/badge';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

const columns: ColumnDef<SiteRow>[] = [
  {
    accessorKey: 'domain',
    meta: { title: 'Domain' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Domain" />,
    cell: ({ row }) => <span className="font-medium">{row.original.domain}</span>,
    filterFn: 'includesString',
  },
  {
    accessorKey: 'type',
    meta: { title: 'Tip' },
    header: 'Tip',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.type}</span>,
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'senderEmail',
    meta: { title: 'Gönderen' },
    header: 'Gönderen',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.senderEmail ?? '—'}</span>,
  },
  {
    accessorKey: 'status',
    meta: { title: 'Durum' },
    header: 'Durum',
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
];

export function SitesTable({ sites }: { sites: SiteRow[] }) {
  const facets: FacetConfig[] = React.useMemo(() => {
    const types = Array.from(new Set(sites.map((s) => s.type))).sort();
    return types.length > 1
      ? [{ columnId: 'type', title: 'Tip', options: types.map((t) => ({ label: t, value: t })) }]
      : [];
  }, [sites]);

  return (
    <DataTable
      columns={columns}
      data={sites}
      searchColumnId="domain"
      searchPlaceholder="Domain ara…"
      facets={facets}
      initialSorting={[{ id: 'domain', desc: false }]}
      emptyLabel="Henüz site yok."
    />
  );
}
