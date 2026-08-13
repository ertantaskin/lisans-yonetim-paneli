'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import {
  ArrowRight,
  Ban,
  CheckCircle2,
  ExternalLink,
  Globe,
  Info,
  MoreHorizontal,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { ReviewRow } from '../app/review/queries';
import { fmtDateTime } from '../lib/utils';
import { rejectAction, releaseAction, type ActionState } from '../app/review/actions';
import { Button } from './ui/button';
import { useConfirm } from './ui/confirm';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';

const baseColumns: ColumnDef<ReviewRow>[] = [
  {
    accessorKey: 'remoteOrderId',
    meta: { title: 'Sipariş No' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Sipariş No" />,
    // KARAR SİPARİŞ GÖRÜLMEDEN VERİLİYORDU: satırda yalnız düz metin sipariş no vardı, operatör
    // hangi ürünün kaç adet satıldığını görmek için numarayı kopyalayıp /orders'ta aramak
    // zorundaydı (o liste de en yeni 200 kayıtla sınırlı). `id` zaten sipariş UUID'si → doğrudan bağla.
    cell: ({ row }) => (
      <Link
        href={`/orders/${row.original.id}`}
        className="font-medium tabular-nums underline-offset-2 hover:underline"
        title="Sipariş detayını aç (ürünler, adetler, geçmiş)"
      >
        {row.original.remoteOrderId}
      </Link>
    ),
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
    // Dolandırıcılık şüphesiyle tutulan siparişte asıl bağlam müşteri geçmişidir
    // (risk skoru, değişim oranı, etiket/not) → müşteri 360 ekranına bağlanır.
    cell: ({ row }) => (
      <Link
        href={`/customers/${encodeURIComponent(row.original.customerEmail)}`}
        className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        title="Müşteri geçmişi: sipariş/değişim geçmişi ve risk işaretleri"
      >
        {row.original.customerEmail}
      </Link>
    ),
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

/** Satır aksiyonları — Onayla (release, confirm'li) / Reddet (gerekçe modalı).
 *  support-table ile tutarlı: kompakt MoreHorizontal (icon-sm) dropdown. */
function ReviewRowActions({
  row,
  onError,
  onResult,
}: {
  row: ReviewRow;
  onError: (message: string) => void;
  onResult: (row: ReviewRow, state: ActionState) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const { confirm, dialog } = useConfirm();

  const approve = async () => {
    const ok = await confirm({
      title: `${row.remoteOrderId} siparişi onaylansın mı?`,
      description:
        'İnceleme kaldırılır ve teslimat başlar: uygun stok müşteriye atanır, teslimat e-postası gider. Stok yetersizse sipariş kısmi/bekleyen olarak işlenir.',
      confirmLabel: 'Onayla ve teslim et',
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await releaseAction(row.id);
      // SONUÇ YUTULMAZ: satır listeden düştü diye teslim edildiği varsayılamaz — stok
      // yetersizse hiçbir lisans atanmamış olabilir (sipariş sessizce /pending'e düşer).
      if (!res.ok) onError(res.error ?? 'Onaylanamadı');
      else onResult(row, res);
    });
  };

  const reject = async () => {
    const res0 = await confirm({
      title: 'Sipariş reddedilsin mi?',
      description: `${row.remoteOrderId} · ${row.customerEmail} — sipariş kapatılır, satırlar iptal işaretlenir ve müşteriye lisans GİTMEZ.`,
      tone: 'danger',
      confirmLabel: 'Reddet',
      reason: {
        label: 'Red gerekçesi',
        placeholder: 'Neden reddedildiğini yazın…',
        required: true,
        hint: 'Gerekçe denetim kaydına yazılır.',
      },
    });
    if (!res0) return;
    startTransition(async () => {
      const res = await rejectAction(row.id, res0.reason);
      if (!res.ok) onError(res.error ?? 'Reddedilemedi');
      else onResult(row, res);
    });
  };

  return (
    <>
    {dialog}
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={pending}
          title="Aksiyonlar"
          aria-label={`${row.remoteOrderId} siparişi aksiyonları`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* Karar öncesi bağlam: sipariş içeriğini (ürün/adet/geçmiş) görmeden onay/red verilmesin. */}
        <DropdownMenuItem asChild>
          <Link href={`/orders/${row.id}`}>
            <ExternalLink />
            Siparişi aç
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void approve()} disabled={pending}>
          <CheckCircle2 />
          {pending ? 'İşleniyor…' : 'Onayla'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void reject()}
          disabled={pending}
          className="text-destructive focus:text-destructive"
        >
          <Ban />
          Reddet
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}

/** Sonuç kutusunun tonuna göre ikon (Alert varyantıyla aynı dil). */
const RESULT_ICON = {
  success: CheckCircle2,
  warning: TriangleAlert,
  info: Info,
} as const;

export function ReviewTable({ items }: { items: ReviewRow[] }) {
  const [error, setError] = React.useState<string | null>(null);
  /**
   * Son işlemin SONUCU. Onay/red sonrası satır listeden düşüyordu ve ekranda hiçbir iz
   * kalmıyordu → operatör "onayladım, gitti" sanıyordu. Stok yetersizken hiçbir lisans
   * atanmamış olabilir; o durum YEŞİL gösterilmez (uyarı tonu + Bekleyen Teslimatlar linki).
   */
  const [result, setResult] = React.useState<{ row: ReviewRow; state: ActionState } | null>(null);

  const handleError = React.useCallback((message: string) => {
    setResult(null);
    setError(message);
  }, []);

  const handleResult = React.useCallback((row: ReviewRow, state: ActionState) => {
    setError(null);
    setResult({ row, state });
  }, []);

  const columns = React.useMemo<ColumnDef<ReviewRow>[]>(
    () => [
      ...baseColumns,
      {
        id: 'actions',
        header: () => <span className="sr-only">Aksiyonlar</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <ReviewRowActions
              row={row.original}
              onError={handleError}
              onResult={handleResult}
            />
          </div>
        ),
        enableSorting: false,
        enableHiding: false,
      },
    ],
    [handleError, handleResult],
  );

  const resultTone = result?.state.tone ?? 'info';
  const ResultIcon = RESULT_ICON[resultTone];
  // Teslim edilmediyse operatörün gideceği yer Bekleyen Teslimatlar (kalan orada tamamlanır).
  const resultNeedsStock =
    result?.state.status === 'partial' || result?.state.status === 'pending';

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

      {result && (
        <Alert variant={resultTone}>
          <ResultIcon />
          <div className="min-w-0 flex-1">
            <AlertTitle>{result.row.remoteOrderId}</AlertTitle>
            <AlertDescription>
              {result.state.message ?? 'İşlem tamamlandı.'}
              <span className="mt-2 flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link href={`/orders/${result.row.id}`}>
                    Siparişi aç <ArrowRight className="size-3.5" />
                  </Link>
                </Button>
                {resultNeedsStock && (
                  <Button asChild variant="outline" size="sm">
                    <Link href="/pending">
                      Bekleyen Teslimatlar <ArrowRight className="size-3.5" />
                    </Link>
                  </Button>
                )}
              </span>
            </AlertDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setResult(null)}
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

    </div>
  );
}
