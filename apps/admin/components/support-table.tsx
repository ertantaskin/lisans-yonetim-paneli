'use client';
import * as React from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Ban,
  CheckCircle2,
  Clock,
  MessageCircleQuestion,
  MoreHorizontal,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { ReplacementRow } from '../app/support/queries';
import { fmtDateTime } from '../lib/utils';
import {
  approveReplacementAction,
  rejectReplacementAction,
  requestInfoReplacementAction,
} from '../app/support/actions';
import { Badge, StatusBadge } from './ui/badge';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Label, Textarea } from './ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

/** Not girişli aksiyon (reddet / bilgi iste) için modal durumu. */
type NoteAction = { kind: 'reject' | 'request-info'; row: ReplacementRow };

const NOTE_META: Record<NoteAction['kind'], { title: string; label: string; cta: string }> = {
  reject: {
    title: 'Talebi reddet',
    label: 'Red gerekçesi (müşteriye görünür)',
    cta: 'Reddet',
  },
  'request-info': {
    title: 'Müşteriden bilgi iste',
    label: 'İstenen bilgi / not',
    cta: 'Bilgi İste',
  },
};

const baseColumns: ColumnDef<ReplacementRow>[] = [
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
    accessorKey: 'reason',
    meta: { title: 'Gerekçe' },
    header: 'Gerekçe',
    cell: ({ row }) => (
      <span className="line-clamp-2 max-w-xs text-muted-foreground" title={row.original.reason}>
        {row.original.reason}
      </span>
    ),
    enableSorting: false,
  },
  {
    accessorKey: 'withinWarranty',
    meta: { title: 'Garanti' },
    header: 'Garanti',
    cell: ({ row }) =>
      row.original.withinWarranty ? (
        <Badge variant="success">
          <ShieldCheck /> garanti içi
        </Badge>
      ) : (
        <Badge variant="warning">
          <TriangleAlert /> garanti dışı
        </Badge>
      ),
    filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
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
];

/** open/info_requested durumunda aksiyon alınabilir; approved/rejected terminaldir. */
function isActionable(status: string) {
  return status === 'open' || status === 'info_requested';
}

/** Değişim talebi satır aksiyonları — Onayla (confirm) / Reddet / Bilgi İste (not modalı). */
function ReplacementRowActions({
  row,
  onNote,
  onError,
}: {
  row: ReplacementRow;
  onNote: (action: NoteAction) => void;
  onError: (message: string) => void;
}) {
  const [pending, startTransition] = React.useTransition();

  if (!isActionable(row.status)) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const approve = () => {
    if (
      !window.confirm(
        `${row.remoteOrderId} için değişim onaylansın mı?\n\nMevcut atama geri alınır ve stoktan yeni bir birim atanır. Stok yoksa işlem yapılmaz.`,
      )
    )
      return;
    startTransition(async () => {
      const res = await approveReplacementAction(row.id);
      if (!res.ok) onError(res.error ?? 'Onaylanamadı');
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
          aria-label={`${row.remoteOrderId} talebi aksiyonları`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={approve} disabled={pending}>
          <CheckCircle2 />
          {pending ? 'İşleniyor…' : 'Onayla (değiştir)'}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onNote({ kind: 'request-info', row })} disabled={pending}>
          <MessageCircleQuestion />
          Bilgi İste
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => onNote({ kind: 'reject', row })}
          disabled={pending}
          className="text-destructive focus:text-destructive"
        >
          <Ban />
          Reddet
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Not girişli modal (reddet / bilgi iste). Native Dialog primitifi yok → basit overlay. */
function NoteDialog({
  action,
  onClose,
  onError,
}: {
  action: NoteAction;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const meta = NOTE_META[action.kind];
  const [note, setNote] = React.useState('');
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = () => {
    if (!note.trim()) {
      setLocalError('Not zorunlu');
      return;
    }
    setLocalError(null);
    startTransition(async () => {
      const res =
        action.kind === 'reject'
          ? await rejectReplacementAction(action.row.id, note)
          : await requestInfoReplacementAction(action.row.id, note);
      if (res.ok) onClose();
      else {
        onError(res.error ?? 'İşlenemedi');
        onClose();
      }
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={meta.title}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{meta.title}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {action.row.remoteOrderId} · {action.row.customerEmail}
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
          <Label htmlFor="replacement-note">{meta.label}</Label>
          <Textarea
            id="replacement-note"
            ref={textareaRef}
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Kısa bir açıklama yazın…"
          />
          {localError && <p className="text-xs text-destructive">{localError}</p>}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Vazgeç
          </Button>
          <Button
            variant={action.kind === 'reject' ? 'danger' : 'default'}
            size="sm"
            onClick={submit}
            disabled={pending}
          >
            {pending ? 'İşleniyor…' : meta.cta}
          </Button>
        </div>
      </div>
    </div>
  );
}

const facets: FacetConfig[] = [
  {
    columnId: 'status',
    title: 'Durum',
    options: [
      { label: 'Açık', value: 'open', icon: Clock },
      { label: 'Bilgi istendi', value: 'info_requested', icon: MessageCircleQuestion },
      { label: 'Onaylandı', value: 'approved', icon: CheckCircle2 },
      { label: 'Reddedildi', value: 'rejected', icon: Ban },
    ],
  },
  {
    columnId: 'withinWarranty',
    title: 'Garanti',
    options: [
      { label: 'Garanti içi', value: 'true', icon: ShieldCheck },
      { label: 'Garanti dışı', value: 'false', icon: TriangleAlert },
    ],
  },
];

export function SupportTable({ replacements }: { replacements: ReplacementRow[] }) {
  const [noteAction, setNoteAction] = React.useState<NoteAction | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleError = React.useCallback((message: string) => setError(message), []);

  const columns = React.useMemo<ColumnDef<ReplacementRow>[]>(
    () => [
      ...baseColumns,
      {
        id: 'actions',
        header: () => <span className="sr-only">Aksiyonlar</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <ReplacementRowActions row={row.original} onNote={setNoteAction} onError={handleError} />
          </div>
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
        data={replacements}
        searchColumnId="remoteOrderId"
        searchPlaceholder="Sipariş no veya e-posta…"
        facets={facets}
        initialSorting={[{ id: 'createdAt', desc: true }]}
        emptyLabel="Değişim talebi yok."
      />

      {noteAction && (
        <NoteDialog action={noteAction} onClose={() => setNoteAction(null)} onError={handleError} />
      )}
    </div>
  );
}
