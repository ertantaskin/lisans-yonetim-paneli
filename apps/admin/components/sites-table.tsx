'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, CircleCheck, KeyRound, MoreHorizontal, TriangleAlert, X } from 'lucide-react';
import type { SiteRow } from '../lib/api';
import { siteTypeLabel } from '../lib/labels';
import { rotateSecretAction, setSiteStatusAction } from '../app/sites/actions';
import { StatusBadge } from './ui/badge';
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
import type { FacetConfig } from './data-table/data-table-toolbar';

const baseColumns: ColumnDef<SiteRow>[] = [
  {
    accessorKey: 'domain',
    meta: { title: 'Domain' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Domain" />,
    cell: ({ row }) => (
      <Link
        href={`/sites/${row.original.id}`}
        className="font-medium text-foreground hover:underline"
      >
        {row.original.domain}
      </Link>
    ),
    filterFn: 'includesString',
  },
  {
    accessorKey: 'type',
    meta: { title: 'Tip' },
    header: 'Tip',
    cell: ({ row }) => <span className="text-muted-foreground">{siteTypeLabel(row.original.type)}</span>,
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

/** Rotasyon başarısında bir kez gösterilecek secret bilgisi. */
type RotatedNotice = { domain: string; hmacSecret: string };

/** Site satır aksiyonları — şu an: HMAC secret yenile (confirm + loglu). */
function SiteRowActions({
  site,
  onRotated,
  onError,
}: {
  site: SiteRow;
  onRotated: (notice: RotatedNotice) => void;
  onError: (message: string) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const suspended = site.status === 'suspended';

  const rotate = () => {
    if (
      !window.confirm(
        `${site.domain} için HMAC secret yenilensin mi?\n\nEski secret 24 saat daha geçerli kalır (WP eklentisi kesintisiz yeni secret'a geçer). Yeni secret yalnız bir kez gösterilir.`,
      )
    )
      return;
    startTransition(async () => {
      const res = await rotateSecretAction(site.id);
      if (res.ok && res.hmacSecret) onRotated({ domain: site.domain, hmacSecret: res.hmacSecret });
      else onError(res.error ?? 'Secret yenilenemedi');
    });
  };

  const toggleStatus = () => {
    const next = suspended ? 'active' : 'suspended';
    const msg = suspended
      ? `${site.domain} yeniden aktifleştirilsin mi? Yeni sipariş push kabulü tekrar açılır.`
      : `${site.domain} askıya alınsın mı?\n\nAskıdayken HMAC auth reddedilir — yeni sipariş push edilemez.`;
    if (!window.confirm(msg)) return;
    startTransition(async () => {
      const res = await setSiteStatusAction(site.id, next);
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
          aria-label={`${site.domain} aksiyonları`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={rotate} disabled={pending}>
          <KeyRound />
          {pending ? 'Yenileniyor…' : 'Secret Yenile'}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={toggleStatus} disabled={pending}>
          {suspended ? <CircleCheck /> : <Ban />}
          {suspended ? 'Aktifleştir' : 'Askıya Al'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SitesTable({ sites }: { sites: SiteRow[] }) {
  const [rotated, setRotated] = React.useState<RotatedNotice | null>(null);
  const [rotateError, setRotateError] = React.useState<string | null>(null);

  const handleRotated = React.useCallback((notice: RotatedNotice) => {
    setRotateError(null);
    setRotated(notice);
  }, []);
  const handleError = React.useCallback((message: string) => {
    setRotated(null);
    setRotateError(message);
  }, []);

  const columns = React.useMemo<ColumnDef<SiteRow>[]>(
    () => [
      ...baseColumns,
      {
        id: 'actions',
        header: () => <span className="sr-only">Aksiyonlar</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <SiteRowActions site={row.original} onRotated={handleRotated} onError={handleError} />
          </div>
        ),
        enableSorting: false,
        enableHiding: false,
      },
    ],
    [handleRotated, handleError],
  );

  const facets: FacetConfig[] = React.useMemo(() => {
    const types = Array.from(new Set(sites.map((s) => s.type))).sort();
    return types.length > 1
      ? [{ columnId: 'type', title: 'Tip', options: types.map((t) => ({ label: siteTypeLabel(t), value: t })) }]
      : [];
  }, [sites]);

  return (
    <div className="space-y-4">
      {rotated && (
        <Alert variant="warning">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>Yeni HMAC secret yalnız bir kez gösterilir — güvenli saklayın</AlertTitle>
            <AlertDescription>
              <div className="mb-1.5 text-foreground/70">
                {rotated.domain} · eski secret 24 saat daha geçerli
              </div>
              <div className="break-all font-mono text-xs text-foreground">
                <span className="text-foreground/70">HMAC Secret:</span> {rotated.hmacSecret}
              </div>
            </AlertDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setRotated(null)}
            aria-label="Kapat"
            className="-mr-1 -mt-1 shrink-0"
          >
            <X />
          </Button>
        </Alert>
      )}
      {rotateError && (
        <Alert variant="destructive">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>Secret yenilenemedi</AlertTitle>
            <AlertDescription>{rotateError}</AlertDescription>
          </div>
        </Alert>
      )}

      <DataTable
        columns={columns}
        data={sites}
        searchColumnId="domain"
        searchPlaceholder="Domain ara…"
        facets={facets}
        initialSorting={[{ id: 'domain', desc: false }]}
        emptyLabel="Henüz site yok."
      />
    </div>
  );
}
