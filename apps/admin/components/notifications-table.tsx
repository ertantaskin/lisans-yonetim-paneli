'use client';
import * as React from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Info,
  PackageX,
  RefreshCw,
  Send,
  ShieldAlert,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { NotificationRow } from '../app/notifications/queries';
import { fmtDateTime } from '../lib/utils';
import { checkLowStockAction } from '../app/notifications/actions';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

// ── Seviye → rozet (kritik=danger, uyarı=warning, bilgi=neutral) ──────────────
const SEVERITY: Record<
  string,
  { variant: 'danger' | 'warning' | 'neutral'; label: string; icon: typeof Info }
> = {
  critical: { variant: 'danger', label: 'kritik', icon: ShieldAlert },
  warning: { variant: 'warning', label: 'uyarı', icon: AlertTriangle },
  info: { variant: 'neutral', label: 'bilgi', icon: Info },
};

function SeverityBadge({ severity }: { severity: string }) {
  const meta = SEVERITY[severity] ?? { variant: 'neutral' as const, label: severity, icon: Info };
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant}>
      <Icon />
      {meta.label}
    </Badge>
  );
}

// Bildirim türü → okunur etiket (bilinmeyen tür ham gösterilir).
const TYPE_LABEL: Record<string, string> = {
  low_stock: 'Düşük stok',
  digest_alert: 'Günlük özet uyarısı',
  reconcile_violation: 'Mutabakat ihlali',
};

const baseColumns: ColumnDef<NotificationRow>[] = [
  {
    accessorKey: 'severity',
    meta: { title: 'Seviye' },
    header: 'Seviye',
    cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'type',
    meta: { title: 'Tür' },
    header: 'Tür',
    cell: ({ row }) => (
      <Badge variant="outline">{TYPE_LABEL[row.original.type] ?? row.original.type}</Badge>
    ),
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'title',
    meta: { title: 'Bildirim' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Bildirim" />,
    cell: ({ row }) => (
      <div className="max-w-md">
        <div className="font-medium text-foreground">{row.original.title}</div>
        <div className="line-clamp-2 text-muted-foreground" title={row.original.message}>
          {row.original.message}
        </div>
      </div>
    ),
    // Arama: başlık VEYA mesaj
    filterFn: (row, _id, value) => {
      const q = String(value).toLowerCase();
      return (
        row.original.title.toLowerCase().includes(q) ||
        row.original.message.toLowerCase().includes(q)
      );
    },
  },
  {
    accessorKey: 'sentTelegram',
    meta: { title: 'Telegram' },
    header: 'Telegram',
    cell: ({ row }) =>
      row.original.sentTelegram ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-success">
          <Send className="size-3" /> gönderildi
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      ),
    enableSorting: false,
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

const facets: FacetConfig[] = [
  {
    columnId: 'severity',
    title: 'Seviye',
    options: [
      { label: 'Kritik', value: 'critical', icon: ShieldAlert },
      { label: 'Uyarı', value: 'warning', icon: AlertTriangle },
      { label: 'Bilgi', value: 'info', icon: Info },
    ],
  },
  {
    columnId: 'type',
    title: 'Tür',
    options: [
      { label: 'Düşük stok', value: 'low_stock', icon: PackageX },
      { label: 'Günlük özet uyarısı', value: 'digest_alert', icon: Bell },
      { label: 'Mutabakat ihlali', value: 'reconcile_violation', icon: ShieldAlert },
    ],
  },
];

/** Düşük stok kontrolünü elle çalıştırır; sonuç/hata mesajı yüzeye çıkar. */
function LowStockCheckButton({
  onResult,
}: {
  onResult: (r: { ok: boolean; created?: number; error?: string }) => void;
}) {
  const [pending, startTransition] = React.useTransition();

  const run = () => {
    startTransition(async () => {
      const res = await checkLowStockAction();
      onResult(res);
    });
  };

  return (
    <Button variant="outline" size="sm" onClick={run} disabled={pending}>
      <RefreshCw className={pending ? 'animate-spin' : undefined} />
      {pending ? 'Kontrol ediliyor…' : 'Düşük stok kontrolü çalıştır'}
    </Button>
  );
}

export function NotificationsTable({ notifications }: { notifications: NotificationRow[] }) {
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const handleResult = React.useCallback(
    (r: { ok: boolean; created?: number; error?: string }) => {
      if (r.ok) {
        setError(null);
        setSuccess(
          r.created && r.created > 0
            ? `${r.created} yeni düşük stok bildirimi üretildi.`
            : 'Kontrol tamamlandı — yeni bildirim yok.',
        );
      } else {
        setSuccess(null);
        setError(r.error ?? 'Kontrol çalıştırılamadı');
      }
    },
    [],
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <LowStockCheckButton onResult={handleResult} />
      </div>

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
            <AlertTitle>Kontrol çalıştı</AlertTitle>
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
        columns={baseColumns}
        data={notifications}
        searchColumnId="title"
        searchPlaceholder="Başlık veya mesaj…"
        facets={facets}
        initialSorting={[{ id: 'createdAt', desc: true }]}
        emptyLabel="Bildirim yok."
      />
    </div>
  );
}
