'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Ban,
  CheckCircle2,
  MoreHorizontal,
  PackagePlus,
  PackageX,
  Replace,
  ShieldX,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { BatchRow } from '../app/batches/queries';
import { fmtDateTime } from '../lib/utils';
import { bulkReplaceBatchAction, recallBatchAction } from '../app/batches/actions';
import { Badge } from './ui/badge';
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

/** Parti durumu → rozet (batch_status: active/recalled/voided). */
function BatchStatusBadge({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <Badge variant="success">
        <CheckCircle2 /> aktif
      </Badge>
    );
  }
  if (status === 'recalled') {
    return (
      <Badge variant="danger">
        <ShieldX /> geri çekildi
      </Badge>
    );
  }
  if (status === 'voided') {
    return (
      <Badge variant="outline">
        <Ban /> iptal
      </Badge>
    );
  }
  return <Badge variant="neutral">{status}</Badge>;
}

const baseColumns: ColumnDef<BatchRow>[] = [
  {
    accessorKey: 'label',
    meta: { title: 'Parti' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Parti" />,
    cell: ({ row }) => <span className="font-medium">{row.original.label}</span>,
    // Arama: parti etiketi VEYA ürün sku/adı
    filterFn: (row, _id, value) => {
      const q = String(value).toLowerCase();
      return (
        row.original.label.toLowerCase().includes(q) ||
        row.original.productSku.toLowerCase().includes(q) ||
        row.original.productName.toLowerCase().includes(q)
      );
    },
  },
  {
    accessorKey: 'supplierName',
    meta: { title: 'Tedarikçi' },
    header: 'Tedarikçi',
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.supplierName ?? '—'}</span>
    ),
  },
  {
    id: 'product',
    accessorFn: (row) => `${row.productSku} ${row.productName}`,
    meta: { title: 'Ürün' },
    header: 'Ürün',
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="text-foreground">{row.original.productName}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{row.original.productSku}</span>
      </div>
    ),
  },
  {
    accessorKey: 'status',
    meta: { title: 'Durum' },
    header: 'Durum',
    cell: ({ row }) => <BatchStatusBadge status={row.original.status} />,
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'unsoldCount',
    meta: { title: 'Satılmamış' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Satılmamış" />,
    cell: ({ row }) => <span className="tabular-nums">{row.original.unsoldCount}</span>,
  },
  {
    accessorKey: 'soldCount',
    meta: { title: 'Satılmış' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Satılmış" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">{row.original.soldCount}</span>
    ),
  },
  {
    accessorKey: 'receivedAt',
    meta: { title: 'Teslim Alındı' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Teslim Alındı" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {fmtDateTime(row.original.receivedAt)}
      </span>
    ),
    sortingFn: 'datetime',
  },
];

/** Yalnız aktif parti geri çekilebilir. */
function isRecallable(status: string) {
  return status === 'active';
}

/** Geri çekilmiş partide satılmış kalem varsa toplu değiştirme sunulabilir (§13). */
function canBulkReplace(batch: BatchRow) {
  return batch.status === 'recalled' && batch.soldCount > 0;
}

/** Yalnız aktif partiye yeni stok girilebilir (geri çekilmiş/iptal partiye ekleme anlamsız). */
function canAddStock(batch: BatchRow) {
  return batch.status === 'active';
}

/**
 * Parti satır aksiyonları — Bu partiye stok gir (aktif) · Geri Çek (aktif) VEYA
 * Toplu Değiştir (geri çekilmiş + satılmış). Recall/toplu-değiştirme aksiyonları değişmedi;
 * stok girişi artık ÜRÜN DETAYINDA (import ürün-merkezli oldu) → ön-dolumlu import formuna
 * (/products/{productId}?batchId=…) bağlanan ayrı bir menü kalemi.
 */
function BatchRowActions({
  batch,
  onRecall,
  onBulkReplace,
}: {
  batch: BatchRow;
  onRecall: (batch: BatchRow) => void;
  onBulkReplace: (batch: BatchRow) => void;
}) {
  const recallable = isRecallable(batch.status);
  const bulkReplaceable = canBulkReplace(batch);
  const addStockable = canAddStock(batch);
  if (!recallable && !bulkReplaceable && !addStockable) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Aksiyonlar"
          aria-label={`${batch.label} aksiyonları`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {addStockable && (
          <DropdownMenuItem asChild>
            <Link href={`/products/${batch.productId}?batchId=${batch.id}`}>
              <PackagePlus />
              Bu partiye stok gir
            </Link>
          </DropdownMenuItem>
        )}
        {addStockable && recallable && <DropdownMenuSeparator />}
        {recallable && (
          <DropdownMenuItem
            onSelect={() => onRecall(batch)}
            className="text-destructive focus:text-destructive"
          >
            <PackageX />
            Geri Çek (Recall)
          </DropdownMenuItem>
        )}
        {bulkReplaceable && (
          <DropdownMenuItem onSelect={() => onBulkReplace(batch)}>
            <Replace />
            Toplu Değiştir (satılanları)
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Recall başarı bildirimi (bir kez). */
type RecallNotice = { label: string; voided: number; soldNeedingReplacement: number };

/** Sebep-girişli recall modalı. Native Dialog primitifi yok → basit overlay (support-table deseni). */
function RecallDialog({
  batch,
  onClose,
  onDone,
  onError,
}: {
  batch: BatchRow;
  onClose: () => void;
  onDone: (notice: RecallNotice) => void;
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
      const res = await recallBatchAction(batch.id, reason);
      if (res.ok) {
        onDone({
          label: batch.label,
          voided: res.voided ?? 0,
          soldNeedingReplacement: res.soldNeedingReplacement ?? 0,
        });
      } else {
        onError(res.error ?? 'Geri çekilemedi');
        onClose();
      }
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Partiyi geri çek"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Partiyi geri çek</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {batch.label} · {batch.productName}
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

        <Alert variant="warning" className="mb-3">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertDescription>
              Satılmamış {batch.unsoldCount} birim iptal edilecek (geri alınamaz).
              {batch.soldCount > 0 && (
                <> Satılmış {batch.soldCount} birim değişim gerektirir.</>
              )}
            </AlertDescription>
          </div>
        </Alert>

        <div className="space-y-1.5">
          <Label htmlFor="recall-reason">Geri çekme sebebi (audit'e kaydedilir)</Label>
          <Textarea
            id="recall-reason"
            ref={textareaRef}
            rows={4}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ör: tedarikçi hatalı key partisi bildirdi…"
          />
          {localError && <p className="text-xs text-destructive">{localError}</p>}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Vazgeç
          </Button>
          <Button variant="danger" size="sm" onClick={submit} disabled={pending}>
            {pending ? 'İşleniyor…' : 'Geri Çek'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Toplu değiştirme sonucu bildirimi. */
type BulkReplaceNotice = { label: string; total: number; replaced: number; skippedNoStock: number };

/**
 * Toplu değiştirme onay modalı (§13). Sebep girişi yok — onay + sonuç. Satılmış kalemler
 * MEVCUT değişim makinesiyle yenisiyle değiştirilir; stok bitince atlanır.
 */
function BulkReplaceDialog({
  batch,
  onClose,
  onDone,
  onError,
}: {
  batch: BatchRow;
  onClose: () => void;
  onDone: (notice: BulkReplaceNotice) => void;
  onError: (message: string) => void;
}) {
  const [pending, startTransition] = React.useTransition();

  const submit = () => {
    startTransition(async () => {
      const res = await bulkReplaceBatchAction(batch.id);
      if (res.ok) {
        onDone({
          label: batch.label,
          total: res.total ?? 0,
          replaced: res.replaced ?? 0,
          skippedNoStock: res.skippedNoStock ?? 0,
        });
      } else {
        onError(res.error ?? 'Toplu değiştirme başarısız');
        onClose();
      }
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Satılan kalemleri toplu değiştir"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Satılanları toplu değiştir</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {batch.label} · {batch.productName}
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

        <Alert variant="warning" className="mb-4">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertDescription>
              Bu partiye ait satılmış {batch.soldCount} birimin aktif atamaları iptal edilip
              stoktan yenisiyle değiştirilecek. Stok yetmeyen kalemler atlanır (mevcut atama korunur).
            </AlertDescription>
          </div>
        </Alert>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Vazgeç
          </Button>
          <Button variant="default" size="sm" onClick={submit} disabled={pending}>
            {pending ? 'İşleniyor…' : 'Toplu Değiştir'}
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
      { label: 'Aktif', value: 'active', icon: CheckCircle2 },
      { label: 'Geri çekildi', value: 'recalled', icon: ShieldX },
      { label: 'İptal', value: 'voided', icon: Ban },
    ],
  },
];

export function BatchesTable({ batches }: { batches: BatchRow[] }) {
  const [recallTarget, setRecallTarget] = React.useState<BatchRow | null>(null);
  const [bulkTarget, setBulkTarget] = React.useState<BatchRow | null>(null);
  const [notice, setNotice] = React.useState<RecallNotice | null>(null);
  const [bulkNotice, setBulkNotice] = React.useState<BulkReplaceNotice | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleDone = React.useCallback((n: RecallNotice) => {
    setError(null);
    setBulkNotice(null);
    setNotice(n);
    setRecallTarget(null);
  }, []);
  const handleBulkDone = React.useCallback((n: BulkReplaceNotice) => {
    setError(null);
    setNotice(null);
    setBulkNotice(n);
    setBulkTarget(null);
  }, []);
  const handleError = React.useCallback((message: string) => {
    setNotice(null);
    setBulkNotice(null);
    setError(message);
  }, []);

  const columns = React.useMemo<ColumnDef<BatchRow>[]>(
    () => [
      ...baseColumns,
      {
        id: 'actions',
        header: () => <span className="sr-only">Aksiyonlar</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <BatchRowActions
              batch={row.original}
              onRecall={setRecallTarget}
              onBulkReplace={setBulkTarget}
            />
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
      {notice && (
        <Alert variant={notice.soldNeedingReplacement > 0 ? 'warning' : 'success'}>
          {notice.soldNeedingReplacement > 0 ? <TriangleAlert /> : <CheckCircle2 />}
          <div className="min-w-0 flex-1">
            <AlertTitle>Parti geri çekildi — {notice.label}</AlertTitle>
            <AlertDescription>
              Satılmamış {notice.voided} birim iptal edildi.
              {notice.soldNeedingReplacement > 0 && (
                <> Satılmış {notice.soldNeedingReplacement} birim değişim/telafi gerektiriyor.</>
              )}
            </AlertDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setNotice(null)}
            aria-label="Kapat"
            className="-mr-1 -mt-1 shrink-0"
          >
            <X />
          </Button>
        </Alert>
      )}
      {bulkNotice && (
        <Alert variant={bulkNotice.skippedNoStock > 0 ? 'warning' : 'success'}>
          {bulkNotice.skippedNoStock > 0 ? <TriangleAlert /> : <CheckCircle2 />}
          <div className="min-w-0 flex-1">
            <AlertTitle>Toplu değiştirme tamamlandı — {bulkNotice.label}</AlertTitle>
            <AlertDescription>
              {bulkNotice.replaced}/{bulkNotice.total} satılmış birim yenisiyle değiştirildi.
              {bulkNotice.skippedNoStock > 0 && (
                <> Stok yetmediği için {bulkNotice.skippedNoStock} birim atlandı.</>
              )}
            </AlertDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setBulkNotice(null)}
            aria-label="Kapat"
            className="-mr-1 -mt-1 shrink-0"
          >
            <X />
          </Button>
        </Alert>
      )}
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
        data={batches}
        searchColumnId="label"
        searchPlaceholder="Parti etiketi veya ürün…"
        facets={facets}
        initialSorting={[{ id: 'receivedAt', desc: true }]}
        emptyLabel="Henüz parti yok."
      />

      {recallTarget && (
        <RecallDialog
          batch={recallTarget}
          onClose={() => setRecallTarget(null)}
          onDone={handleDone}
          onError={handleError}
        />
      )}

      {bulkTarget && (
        <BulkReplaceDialog
          batch={bulkTarget}
          onClose={() => setBulkTarget(null)}
          onDone={handleBulkDone}
          onError={handleError}
        />
      )}
    </div>
  );
}
