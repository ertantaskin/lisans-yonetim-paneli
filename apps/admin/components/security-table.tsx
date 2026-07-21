'use client';
import * as React from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Activity,
  Ban,
  CheckCircle2,
  Gauge,
  Info,
  RadioTower,
  ScanSearch,
  ShieldAlert,
  ShieldX,
  TriangleAlert,
  UserX,
  X,
} from 'lucide-react';
import type { SecurityEventRow } from '../app/security/queries';
import { scanSecurityAction, anonymizeCustomerAction } from '../app/security/actions';
import { Badge, type BadgeProps } from './ui/badge';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Input, Label } from './ui/input';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

// ── Tip → etiket/ikon (velocity/quota_exceeded/anomaly/blocklist) ────────────
const TYPE_META: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  velocity: { label: 'hız (velocity)', icon: RadioTower },
  quota_exceeded: { label: 'kota aşımı', icon: Gauge },
  anomaly: { label: 'anomali', icon: Activity },
  blocklist: { label: 'kara liste', icon: Ban },
};

// ── Severity → rozet varyant/etiket/ikon (info/warning/critical) ─────────────
const SEVERITY_META: Record<
  string,
  { variant: NonNullable<BadgeProps['variant']>; label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  info: { variant: 'outline', label: 'bilgi', icon: Info },
  warning: { variant: 'warning', label: 'uyarı', icon: TriangleAlert },
  critical: { variant: 'danger', label: 'kritik', icon: ShieldAlert },
};

function TypeCell({ type }: { type: string }) {
  const meta = TYPE_META[type] ?? { label: type, icon: ShieldAlert };
  const Icon = meta.icon;
  return (
    <span className="inline-flex items-center gap-1.5 text-foreground">
      <Icon className="size-3.5 text-muted-foreground" />
      {meta.label}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const meta = SEVERITY_META[severity] ?? {
    variant: 'neutral' as const,
    label: severity,
    icon: Info,
  };
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant}>
      <Icon />
      {meta.label}
    </Badge>
  );
}

const columns: ColumnDef<SecurityEventRow>[] = [
  {
    accessorKey: 'type',
    meta: { title: 'Tür' },
    header: 'Tür',
    cell: ({ row }) => <TypeCell type={row.original.type} />,
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'severity',
    meta: { title: 'Önem' },
    header: 'Önem',
    cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'subject',
    meta: { title: 'Özne' },
    header: 'Özne',
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.subject ?? '—'}</span>
    ),
    enableSorting: false,
  },
  {
    accessorKey: 'detail',
    meta: { title: 'Detay' },
    header: 'Detay',
    cell: ({ row }) => (
      <span className="line-clamp-2 max-w-md text-muted-foreground" title={row.original.detail}>
        {row.original.detail}
      </span>
    ),
    enableSorting: false,
  },
  {
    accessorKey: 'siteId',
    meta: { title: 'Site' },
    header: 'Site',
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground">
        {row.original.siteId ? row.original.siteId.slice(0, 8) : '—'}
      </span>
    ),
    enableSorting: false,
  },
  {
    accessorKey: 'createdAt',
    meta: { title: 'Zaman' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Zaman" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {new Date(row.original.createdAt).toLocaleString('tr-TR', {
          dateStyle: 'short',
          timeStyle: 'short',
        })}
      </span>
    ),
    sortingFn: 'datetime',
  },
];

const facets: FacetConfig[] = [
  {
    columnId: 'type',
    title: 'Tür',
    options: [
      { label: 'Hız (velocity)', value: 'velocity', icon: RadioTower },
      { label: 'Kota aşımı', value: 'quota_exceeded', icon: Gauge },
      { label: 'Anomali', value: 'anomaly', icon: Activity },
      { label: 'Kara liste', value: 'blocklist', icon: Ban },
    ],
  },
  {
    columnId: 'severity',
    title: 'Önem',
    options: [
      { label: 'Bilgi', value: 'info', icon: Info },
      { label: 'Uyarı', value: 'warning', icon: TriangleAlert },
      { label: 'Kritik', value: 'critical', icon: ShieldAlert },
    ],
  },
];

/** Elle tarama tetikleyici — POST /v1/admin/security/scan. */
function ScanButton({ onError, onDone }: { onError: (m: string) => void; onDone: (n: number) => void }) {
  const [pending, startTransition] = React.useTransition();
  const scan = () => {
    startTransition(async () => {
      const res = await scanSecurityAction();
      if (res.ok) onDone(res.created ?? 0);
      else onError(res.error ?? 'Tarama başarısız');
    });
  };
  return (
    <Button variant="outline" size="sm" onClick={scan} disabled={pending}>
      <ScanSearch />
      {pending ? 'Taranıyor…' : 'Tara'}
    </Button>
  );
}

/** KVKK anonimleştirme formu — TEK YÖNLÜ, confirm + audit uyarısı. */
function AnonymizeForm({
  onError,
  onDone,
}: {
  onError: (m: string) => void;
  onDone: (orders: number, replacements: number) => void;
}) {
  const [email, setEmail] = React.useState('');
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setLocalError('E-posta zorunlu');
      return;
    }
    setLocalError(null);
    if (
      !window.confirm(
        `${trimmed} anonimleştirilsin mi?\n\nTEK YÖNLÜ işlem (§9/KVKK): bu e-postanın PII'ı tüm siparişler ve değişim taleplerinde maskelenir, müşteri kaydı silinir. Sipariş/atama bütünlüğü korunur. Geri alınamaz ve audit_log'a yazılır.`,
      )
    )
      return;
    startTransition(async () => {
      const res = await anonymizeCustomerAction(trimmed);
      if (res.ok) {
        setEmail('');
        onDone(res.anonymizedOrders ?? 0, res.anonymizedReplacements ?? 0);
      } else {
        onError(res.error ?? 'Anonimleştirme başarısız');
      }
    });
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-1 flex items-center gap-2">
        <UserX className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">KVKK anonimleştirme (§9)</h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Verilen e-postanın kişisel verisi tüm kayıtlarda maskelenir (tek yönlü). Sipariş/atama
        bütünlüğü korunur; işlem audit_log'a düşer.
      </p>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="anon-email">Müşteri e-postası</Label>
          <Input
            id="anon-email"
            type="email"
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
            placeholder="musteri@ornek.com"
            className="w-64"
          />
          {localError && <p className="text-xs text-destructive">{localError}</p>}
        </div>
        <Button type="submit" variant="danger" size="sm" disabled={pending}>
          <ShieldX />
          {pending ? 'İşleniyor…' : 'Anonimleştir'}
        </Button>
      </form>
    </div>
  );
}

/** Kapatılabilir bildirim (başarı/hata) satırı. */
function Notice({
  variant,
  title,
  message,
  onClose,
}: {
  variant: 'success' | 'destructive';
  title: string;
  message: string;
  onClose: () => void;
}) {
  return (
    <Alert variant={variant}>
      {variant === 'success' ? <CheckCircle2 /> : <TriangleAlert />}
      <div className="min-w-0 flex-1">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
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
    </Alert>
  );
}

export function SecurityTable({ events }: { events: SecurityEventRow[] }) {
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const handleError = React.useCallback((message: string) => {
    setNotice(null);
    setError(message);
  }, []);
  const handleScanDone = React.useCallback((n: number) => {
    setError(null);
    setNotice(
      n > 0 ? `Tarama tamamlandı — ${n} yeni olay kaydedildi.` : 'Tarama tamamlandı — yeni olay yok.',
    );
  }, []);
  const handleAnonDone = React.useCallback((orders: number, replacements: number) => {
    setError(null);
    setNotice(
      `Anonimleştirme tamamlandı — ${orders} sipariş, ${replacements} değişim talebi maskelendi.`,
    );
  }, []);

  return (
    <div className="space-y-4">
      {error && (
        <Notice
          variant="destructive"
          title="İşlem tamamlanamadı"
          message={error}
          onClose={() => setError(null)}
        />
      )}
      {notice && (
        <Notice
          variant="success"
          title="Tamamlandı"
          message={notice}
          onClose={() => setNotice(null)}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Otomatik askıya alma yok — olaylar insan onayı için yüzeye çıkar (§15).
        </p>
        <ScanButton onError={handleError} onDone={handleScanDone} />
      </div>

      <DataTable
        columns={columns}
        data={events}
        searchColumnId="detail"
        searchPlaceholder="Detay ara…"
        facets={facets}
        initialSorting={[{ id: 'createdAt', desc: true }]}
        emptyLabel="Güvenlik olayı yok."
      />

      <AnonymizeForm onError={handleError} onDone={handleAnonDone} />
    </div>
  );
}
