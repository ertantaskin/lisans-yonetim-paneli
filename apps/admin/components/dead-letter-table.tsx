'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, CheckCircle2, Info, Mail, RefreshCw, TriangleAlert, Webhook, X } from 'lucide-react';
import type { DeadLetterRow } from '../app/ops/queries';
import { fmtDateTime, includesTr } from '../lib/utils';
import { replayAction } from '../app/ops/actions';
import { Badge, StatusBadge } from './ui/badge';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

// ── Kaynak türü → rozet (outbox=webhook, email=e-posta) ──────────────────────
//
// GEÇİCİ YEREL SÖZLÜK: etiketler burada elle yazılıyor. Panelin kuralı rozet metninin CÜMLE
// DÜZENİNDE olması (küçük harfli "webhook"/"mail" aynı satırdaki diğer rozetlerle çelişiyordu)
// ve etiket sözlüklerinin TEK KAYNAKTAN (`lib/labels.ts`) gelmesi. Bu iki değer henüz oraya
// taşınmadı — bu turda `labels.ts` başka bir işçide olduğu için dokunulmadı.
// YAPILACAK: `deadLetterKindLabel` olarak `lib/labels.ts`'e taşı; aşağıdaki facet seçenekleri
// ("Webhook"/"Mail") de aynı kaynaktan okusun, yoksa aynı ekranda iki sözlük ayrışır.
function KindBadge({ kind }: { kind: DeadLetterRow['kind'] }) {
  return kind === 'outbox' ? (
    <Badge variant="outline">
      <Webhook /> Webhook
    </Badge>
  ) : (
    <Badge variant="outline">
      <Mail /> E-posta
    </Badge>
  );
}

/** replayable=false satırlarda gösterilecek varsayılan gerekçe (API sebep göndermezse). */
const DEFAULT_BLOCK_REASON =
  'Bu kayıt yeniden gönderilemez — yalnız teslimat maili ve webhook olayı yeniden kuyruğa alınabilir.';

/**
 * Satır yeniden kuyruğa ALINABİLİR mi + değilse gerekçesi.
 *
 * SAVUNMACI OKUMA: `replayable`/`replayBlockedReason` alanları api tarafından eklendi; admin ve
 * api AYRI imajlar olarak dağıtılır → alan gelmeyebilir (eski api). Bu durumda ESKİ davranış
 * korunur (buton açık kalır) — asıl kapı zaten SUNUCUDA'dır: uygun olmayan kayıt replay ucunda
 * açık mesajla 400 alır ve o mesaj burada gösterilir (sessiz 400 bırakılmaz).
 */
function replayability(row: DeadLetterRow): { replayable: boolean; reason: string } {
  const replayable = row.replayable !== false;
  if (replayable) return { replayable: true, reason: '' };
  const raw = typeof row.replayBlockedReason === 'string' ? row.replayBlockedReason.trim() : '';
  return { replayable: false, reason: raw || DEFAULT_BLOCK_REASON };
}

/**
 * Kaydı yeniden kuyruğa alan satır aksiyonu (replay). Sonuç/hata üst state'e bildirilir.
 *
 * Uygun OLMAYAN kayıtta buton DEVRE DIŞIDIR ve gerekçe satırda GÖRÜNÜR (yalnız tooltip değil):
 * eskiden buton her satırda aktifti, operatör tıklıyor ve API'nin 400'ü "hata" gibi görünüyordu.
 */
function ReplayButton({
  row,
  onResult,
}: {
  row: DeadLetterRow;
  onResult: (r: { ok: boolean; blocked?: boolean; error?: string; label: string }) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const { replayable, reason } = replayability(row);

  const run = () => {
    startTransition(async () => {
      const res = await replayAction(row.kind, row.id);
      onResult({ ok: res.ok, blocked: res.blocked, error: res.error, label: row.label });
    });
  };

  if (!replayable) {
    return (
      <div className="flex flex-col items-end gap-1" title={reason}>
        <Button variant="outline" size="sm" disabled aria-disabled="true">
          <Ban aria-hidden />
          Yeniden gönder
        </Button>
        {/* Gerekçe GÖRÜNÜR olmalı: devre dışı butonun tooltip'i her tarayıcıda/klavyede açılmaz. */}
        <span className="max-w-56 text-right text-xs text-muted-foreground">{reason}</span>
      </div>
    );
  }

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
      // Rozet metinleriyle BİREBİR aynı olmalı (facet "Mail" derken rozet "E-posta" diyordu →
      // operatör süzdüğü şeyle listede gördüğünü eşleştiremiyordu).
      { label: 'Webhook', value: 'outbox', icon: Webhook },
      { label: 'E-posta', value: 'email', icon: Mail },
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

/**
 * Dead-letter tablosu.
 *
 * NOT (kapsam): liste KIRPILMA uyarısı ("N kayıttan M'i gösteriliyor") sayfa seviyesinde
 * basılır (app/ops/page.tsx — `truncated`/`total` orada gelir) → burada TEKRARLANMAZ.
 */
export function DeadLetterTable({ rows }: { rows: DeadLetterRow[] }) {
  const [error, setError] = React.useState<string | null>(null);
  // KURALEN reddedilen istek (API 400) "hata" değil "yapılamaz"dır → ayrı, bilgi tonlu bant.
  const [blocked, setBlocked] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const handleResult = React.useCallback(
    (r: { ok: boolean; blocked?: boolean; error?: string; label: string }) => {
      if (r.ok) {
        setError(null);
        setBlocked(null);
        setSuccess(`"${r.label}" yeniden kuyruğa alındı — worker tekrar deneyecek.`);
        return;
      }
      setSuccess(null);
      if (r.blocked) {
        // Bayat sayfa/eş zamanlı değişim: satır ekranda uygun görünüyordu ama sunucu reddetti.
        // Sessizce yutulmaz — sunucunun insan-okur gerekçesi aynen gösterilir.
        setError(null);
        setBlocked(r.error ?? DEFAULT_BLOCK_REASON);
        return;
      }
      setBlocked(null);
      setError(r.error ?? 'Yeniden gönderilemedi');
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
        // Arama: olay/konu VEYA alıcı e-postası. Türkçe-duyarlı karşılaştırma
        // (`includesTr`): ham `toLowerCase()` "İ"/"I" içeren konu/e-postada sessizce eşleşmiyordu.
        filterFn: (row, _id, value) =>
          includesTr(row.original.label, value) || includesTr(row.original.toEmail ?? '', value),
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
            className="line-clamp-2 max-w-sm whitespace-normal text-muted-foreground"
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
            {fmtDateTime(row.original.updatedAt)}
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

      {blocked && (
        <Alert variant="info">
          <Info />
          <div className="min-w-0 flex-1">
            <AlertTitle>Bu kayıt yeniden gönderilemez</AlertTitle>
            <AlertDescription>{blocked}</AlertDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setBlocked(null)}
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
