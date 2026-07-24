'use client';
import * as React from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, CheckCircle2, Globe, TriangleAlert, X } from 'lucide-react';
import type { ReviewRow } from '../app/review/queries';
import { fmtDateTime } from '../lib/utils';
import { rejectAction, releaseAction } from '../app/review/actions';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Label, Textarea } from './ui/input';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';

const baseColumns: ColumnDef<ReviewRow>[] = [
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
    accessorKey: 'siteDomain',
    meta: { title: 'Site' },
    header: 'Site',
    cell: ({ row }) =>
      row.original.siteDomain ? (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Globe className="size-3.5 shrink-0" /> {row.original.siteDomain}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    enableSorting: false,
  },
  {
    accessorKey: 'customerEmail',
    meta: { title: 'Müşteri' },
    header: 'Müşteri',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.customerEmail}</span>,
  },
  {
    accessorKey: 'lineCount',
    meta: { title: 'Satır' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Satır" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">{row.original.lineCount}</span>
    ),
  },
  {
    accessorKey: 'heldAt',
    meta: { title: 'İncelemeye Alındı' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="İncelemeye Alındı" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {row.original.heldAt ? fmtDateTime(row.original.heldAt) : '—'}
      </span>
    ),
    // heldAt null olabilir → güvenli epoch karşılaştırması (built-in 'datetime' null'da patlar).
    sortingFn: (a, b) => {
      const av = a.original.heldAt ? new Date(a.original.heldAt).getTime() : 0;
      const bv = b.original.heldAt ? new Date(b.original.heldAt).getTime() : 0;
      return av - bv;
    },
  },
  {
    accessorKey: 'heldReason',
    meta: { title: 'Sebep' },
    header: 'Sebep',
    cell: ({ row }) =>
      row.original.heldReason ? (
        <span
          className="line-clamp-2 max-w-xs text-muted-foreground"
          title={row.original.heldReason}
        >
          {row.original.heldReason}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    enableSorting: false,
  },
];

/** Satır aksiyonları — Onayla (release, confirm'li) / Reddet (gerekçe modalı). */
function ReviewRowActions({
  row,
  onReject,
  onError,
}: {
  row: ReviewRow;
  onReject: (row: ReviewRow) => void;
  onError: (message: string) => void;
}) {
  const [pending, startTransition] = React.useTransition();

  const approve = () => {
    if (
      !window.confirm(
        `${row.remoteOrderId} siparişi onaylansın mı?\n\nİnceleme kaldırılır ve teslimat başlar (uygun stok müşteriye atanır). Stok yetersizse sipariş kısmi/bekleyen olarak işlenir.`,
      )
    )
      return;
    startTransition(async () => {
      const res = await releaseAction(row.id);
      if (!res.ok) onError(res.error ?? 'Onaylanamadı');
    });
  };

  return (
    <div className="flex justify-end gap-1.5">
      <Button variant="outline" size="sm" onClick={approve} disabled={pending}>
        <CheckCircle2 />
        {pending ? 'İşleniyor…' : 'Onayla'}
      </Button>
      <Button
        variant="danger-outline"
        size="sm"
        onClick={() => onReject(row)}
        disabled={pending}
      >
        <Ban />
        Reddet
      </Button>
    </div>
  );
}

/** Red gerekçesi modalı. Native Dialog primitifi yok → basit overlay (support deseni). */
function RejectDialog({
  row,
  onClose,
  onError,
}: {
  row: ReviewRow;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [reason, setReason] = React.useState('');
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = () => {
    if (!reason.trim()) {
      setLocalError('Sebep zorunlu');
      return;
    }
    setLocalError(null);
    startTransition(async () => {
      const res = await rejectAction(row.id, reason);
      if (res.ok) onClose();
      else {
        onError(res.error ?? 'Reddedilemedi');
        onClose();
      }
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Siparişi reddet"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Siparişi reddet</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {row.remoteOrderId} · {row.customerEmail}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Kapat"
            className="-mr-1 -mt-1 shrink-0"
          >
            <X />
          </Button>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="review-reject-reason">Red gerekçesi</Label>
          <Textarea
            id="review-reject-reason"
            ref={textareaRef}
            rows={4}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Neden reddedildiğini yazın… (sipariş kapatılır, müşteriye key gitmez)"
          />
          {localError && <p className="text-xs text-destructive">{localError}</p>}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Vazgeç
          </Button>
          <Button variant="danger" size="sm" onClick={submit} disabled={pending}>
            <Ban />
            {pending ? 'İşleniyor…' : 'Reddet'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ReviewTable({ items }: { items: ReviewRow[] }) {
  const [rejectRow, setRejectRow] = React.useState<ReviewRow | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleError = React.useCallback((message: string) => setError(message), []);

  const columns = React.useMemo<ColumnDef<ReviewRow>[]>(
    () => [
      ...baseColumns,
      {
        id: 'actions',
        header: () => <span className="sr-only">Aksiyonlar</span>,
        cell: ({ row }) => (
          <ReviewRowActions row={row.original} onReject={setRejectRow} onError={handleError} />
        ),
        enableSorting: false,
        enableHiding: false,
      },
    ],
    [handleError],
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

      <DataTable
        columns={columns}
        data={items}
        searchColumnId="remoteOrderId"
        searchPlaceholder="Sipariş no veya e-posta…"
        initialSorting={[{ id: 'heldAt', desc: true }]}
        emptyLabel="İnceleme bekleyen sipariş yok."
      />

      {rejectRow && (
        <RejectDialog row={rejectRow} onClose={() => setRejectRow(null)} onError={handleError} />
      )}
    </div>
  );
}
