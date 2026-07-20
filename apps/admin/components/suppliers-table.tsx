'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { BarChart3, MoreHorizontal, Pencil, Power, PowerOff, TriangleAlert } from 'lucide-react';
import type { SupplierRow } from '@/app/suppliers/queries';
import { setSupplierActiveAction } from '@/app/suppliers/actions';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';
import { CreateSupplierForm } from './create-supplier-form';

/** Satır aksiyonları: düzenle + aktif/pasif değiştir. */
function SupplierRowActions({
  supplier,
  onEdit,
  onError,
}: {
  supplier: SupplierRow;
  onEdit: (s: SupplierRow) => void;
  onError: (message: string) => void;
}) {
  const [pending, startTransition] = React.useTransition();

  const toggleActive = () => {
    startTransition(async () => {
      const res = await setSupplierActiveAction(supplier.id, !supplier.active);
      if (!res.ok) onError(res.error ?? 'Durum değiştirilemedi');
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={pending}
          title="Aksiyonlar"
          aria-label={`${supplier.name} aksiyonları`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={`/suppliers/${supplier.id}`}>
            <BarChart3 />
            Karne
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onEdit(supplier)}>
          <Pencil />
          Düzenle
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={toggleActive} disabled={pending}>
          {supplier.active ? <PowerOff /> : <Power />}
          {supplier.active ? 'Pasifleştir' : 'Aktifleştir'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SuppliersTable({ suppliers }: { suppliers: SupplierRow[] }) {
  const [editing, setEditing] = React.useState<SupplierRow | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleEdit = React.useCallback((s: SupplierRow) => {
    setError(null);
    setEditing(s);
  }, []);

  const columns = React.useMemo<ColumnDef<SupplierRow>[]>(
    () => [
      {
        accessorKey: 'name',
        meta: { title: 'Ad' },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Ad" />,
        cell: ({ row }) => (
          <Link
            href={`/suppliers/${row.original.id}`}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {row.original.name}
          </Link>
        ),
        filterFn: 'includesString',
      },
      {
        accessorKey: 'contact',
        meta: { title: 'İletişim' },
        header: 'İletişim',
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.contact ?? '—'}</span>
        ),
      },
      {
        accessorKey: 'notes',
        meta: { title: 'Not' },
        header: 'Not',
        cell: ({ row }) => (
          <span className="block max-w-xs truncate text-muted-foreground" title={row.original.notes ?? ''}>
            {row.original.notes ?? '—'}
          </span>
        ),
        enableSorting: false,
      },
      {
        id: 'active',
        accessorFn: (r) => (r.active ? 'active' : 'passive'),
        meta: { title: 'Durum' },
        header: 'Durum',
        cell: ({ row }) =>
          row.original.active ? (
            <Badge variant="success">aktif</Badge>
          ) : (
            <Badge variant="outline">pasif</Badge>
          ),
        filterFn: (r, id, value: string[]) => value.includes(r.getValue(id)),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Aksiyonlar</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <SupplierRowActions supplier={row.original} onEdit={handleEdit} onError={setError} />
          </div>
        ),
        enableSorting: false,
        enableHiding: false,
      },
    ],
    [handleEdit],
  );

  const facets: FacetConfig[] = React.useMemo(
    () => [
      {
        columnId: 'active',
        title: 'Durum',
        options: [
          { label: 'Aktif', value: 'active' },
          { label: 'Pasif', value: 'passive' },
        ],
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>İşlem başarısız</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </div>
        </Alert>
      )}

      {editing && (
        <Card className="max-w-2xl p-5">
          <h2 className="mb-3 text-sm font-semibold text-foreground">
            Tedarikçi Düzenle · {editing.name}
          </h2>
          <CreateSupplierForm
            key={editing.id}
            supplier={editing}
            onDone={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        </Card>
      )}

      <DataTable
        columns={columns}
        data={suppliers}
        searchColumnId="name"
        searchPlaceholder="Tedarikçi ara…"
        facets={facets}
        initialSorting={[{ id: 'name', desc: false }]}
        emptyLabel="Henüz tedarikçi yok."
      />
    </div>
  );
}
