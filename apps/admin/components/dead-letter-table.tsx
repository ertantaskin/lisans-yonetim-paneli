'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { CheckCircle2, Mail, RefreshCw, TriangleAlert, Webhook, X } from 'lucide-react';
import type { DeadLetterRow } from '../app/ops/queries';
import { replayAction } from '../app/ops/actions';
import { Badge, StatusBadge } from './ui/badge';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

// ── Kaynak türü → rozet (outbox=webhook, email=mail) ─────────────────────────
function KindBadge({ kind }: { kind: DeadLetterRow['kind'] }) {
  return kind === 'outbox' ? (
    <Badge variant="outline">
      <Webhook /> webhook
    </Badge>
  ) : (
    <Badge variant="outline">
      <Mail /> mail
    </Badge>
  );
}

/** Kaydı yeniden kuyruğa alan satır aksiyonu (replay). Sonuç/hata üst state'e bildirilir. */
function ReplayButton({
  row,
  onResult,
}: {
  row: DeadLetterRow;
  onResult: (r: { ok: boolean; error?: string; label: string }) => void;
}) {
  const [pending, startTransition] = React.useTransition();

  const run = () => {
    startTransition(async () => {
      const res = await replayAction(row.kind, row.id);
      onResult({ ok: res.ok, error: res.error, label: row.label });
    });
  };

  return (
    <div className="flex justify-end">
      <Button variant="outline" size="sm" onClick={run} disabled={pending}>
        <RefreshCw className={pending ? 'animate-spin' : undefined} />
        {pending ? 'Kuyruğa alınıyor…' : 'Yeniden gönder'}
      </Button>
    </div>
  );
}

const facets: FacetConfig[] = [
  {
    columnId: 'kind',
    title: 'Kaynak',
    options: [
      { label: 'Webhook', value: 'outbox', icon: Webhook },
      { label: 'Mail', value: 'email', icon: Mail },
    ],
  },
  {
    columnId: 'status',
    title: 'Durum',
    options: [
      { label: 'Başarısız', value: 'failed', icon: TriangleAlert },
      { label: 'Geri döndü', value: 'bounced', icon: TriangleAlert },
    ],
  },
];

export function DeadLetterTable({ rows }: { rows: DeadLetterRow[] }) {
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const handleResult = React.useCallback(
    (r: { ok: boolean; error?: string; label: string }) => {
      if (r.ok) {
        setError(null);
        setSuccess(`"${r.label}" yeniden kuyruğa alındı — worker tekrar deneyecek.`);
      } else {
        setSuccess(null);
        setError(r.error ?? 'Yeniden gönderilemedi');
      }
    },
    [],
  );

  const columns = React.useMemo<ColumnDef<DeadLetterRow>[]>(
    () => [
      {
        accessorKey: 'kind',
        meta: { title: 'Kaynak' },
        header: 'Kaynak',
        cell: ({ row }) => <KindBadge kind={row.original.kind} />,
        filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
      },
      {
        accessorKey: 'label',
        meta: { title: 'Olay / Konu' },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Olay / Konu" />,
        cell: ({ row }) => (
          <div className="max-w-xs">
            <div className="truncate font-medium text-foreground" title={row.original.label}>
              {row.original.label}
            </div>
            {row.original.toEmail && (
              <div className="truncate text-muted-foreground">{row.original.toEmail}</div>
            )}
          </div>
        ),
        // Arama: olay/konu VEYA alıcı e-postası
        filterFn: (row, _id, value) => {
          const q = String(value).toLowerCase();
          return (
            row.original.label.toLowerCase().includes(q) ||
            (row.original.toEmail?.toLowerCase().includes(q) ?? false)
          );
        },
      },
      {
        accessorKey: 'status',
        meta: { title: 'Durum' },
        header: 'Durum',
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
        filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
      },
      {
        accessorKey: 'error',
        meta: { title: 'Hata' },
        header: 'Hata',
        cell: ({ row }) => (
          <span
            className="line-clamp-2 max-w-sm text-muted-foreground"
            title={row.original.error ?? undefined}
          >
            {row.original.error ?? '—'}
          </span>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'attempts',
        meta: { title: 'Deneme' },
        header: 'Deneme',
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.attempts === null ? '—' : row.original.attempts}
          </span>
        ),
      },
      {
        id: 'order',
        meta: { title: 'Sipariş' },
        header: 'Sipariş',
        cell: ({ row }) =>
          row.original.orderId ? (
            <Link
              href={`/orders/${row.original.orderId}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              detay
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        enableSorting: false,
      },
      {
        accessorKey: 'updatedAt',
        meta: { title: 'Güncelleme' },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Güncelleme" />,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {new Date(row.original.updatedAt).toLocaleString('tr-TR', {
              dateStyle: 'short',
              timeStyle: 'short',
            })}
          </span>
        ),
        sortingFn: 'datetime',
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Aksiyonlar</span>,
        cell: ({ row }) => <ReplayButton row={row.original} onResult={handleResult} />,
        enableSorting: false,
        enableHiding: false,
      },
    ],
    [handleResult],
  );

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>İşlem tamamlanamadı</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setError(null)}
            aria-label="Kapat"
            className="-mr-1 -mt-1 shrink-0"
          >
            <X />
          </Button>
        </Alert>
      )}

      {success && (
        <Alert variant="success">
          <CheckCircle2 />
          <div className="min-w-0 flex-1">
            <AlertTitle>Yeniden kuyruğa alındı</AlertTitle>
            <AlertDescription>{success}</AlertDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSuccess(null)}
            aria-label="Kapat"
            className="-mr-1 -mt-1 shrink-0"
          >
            <X />
          </Button>
        </Alert>
      )}

      <DataTable
        columns={columns}
        data={rows}
        searchColumnId="label"
        searchPlaceholder="Olay, konu veya e-posta…"
        facets={facets}
        initialSorting={[{ id: 'updatedAt', desc: true }]}
        emptyLabel="Dead-letter kaydı yok — tüm teslimler başarılı."
      />
    </div>
  );
}
