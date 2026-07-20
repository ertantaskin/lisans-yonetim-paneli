'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Pencil, Trash2, TriangleAlert } from 'lucide-react';
import type { TemplateRow } from '../app/templates/queries';
import { deleteTemplateAction } from '../app/templates/actions';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';

/** Şablon kapsam etiketi: site override > ürün > genel varsayılan (§6). */
function scopeLabel(t: TemplateRow): string {
  if (t.siteId && t.productId) return `${t.productName ?? 'ürün'} · ${t.siteDomain ?? 'site'}`;
  if (t.siteId) return `Site: ${t.siteDomain ?? t.siteId}`;
  if (t.productId) return `Ürün: ${t.productName ?? t.productId}`;
  return 'Genel (varsayılan)';
}

function TemplateRowActions({
  template,
  onError,
}: {
  template: TemplateRow;
  onError: (message: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const remove = () => {
    if (!window.confirm('Bu şablon silinsin mi? Bu işlem geri alınamaz.')) return;
    startTransition(async () => {
      const res = await deleteTemplateAction(template.id);
      if (res.ok) router.refresh();
      else onError(res.error ?? 'Şablon silinemedi');
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" disabled={pending} aria-label="Aksiyonlar">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={`/templates/${template.id}`}>
            <Pencil />
            Düzenle
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={remove}
          disabled={pending}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 />
          {pending ? 'Siliniyor…' : 'Sil'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const baseColumns: ColumnDef<TemplateRow>[] = [
  {
    accessorKey: 'subject',
    meta: { title: 'Konu' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Konu" />,
    cell: ({ row }) => (
      <Link
        href={`/templates/${row.original.id}`}
        className="font-medium text-foreground hover:underline"
      >
        {row.original.subject}
      </Link>
    ),
    filterFn: 'includesString',
  },
  {
    id: 'scope',
    meta: { title: 'Kapsam' },
    header: 'Kapsam',
    accessorFn: (t) => scopeLabel(t),
    cell: ({ row }) => (
      <span className="text-muted-foreground">{scopeLabel(row.original)}</span>
    ),
  },
];

export function TemplatesTable({ templates }: { templates: TemplateRow[] }) {
  const [error, setError] = React.useState<string | null>(null);

  const columns = React.useMemo<ColumnDef<TemplateRow>[]>(
    () => [
      ...baseColumns,
      {
        id: 'actions',
        header: () => <span className="sr-only">Aksiyonlar</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <TemplateRowActions template={row.original} onError={setError} />
          </div>
        ),
        enableSorting: false,
        enableHiding: false,
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
      <DataTable
        columns={columns}
        data={templates}
        searchColumnId="subject"
        searchPlaceholder="Konu ara…"
        initialSorting={[{ id: 'subject', desc: false }]}
        emptyLabel="Henüz şablon yok. Yeni şablon oluşturun."
      />
    </div>
  );
}
