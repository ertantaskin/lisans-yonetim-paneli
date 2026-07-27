'use client';
import * as React from 'react';
import { CheckCircle2, ShieldCheck, TriangleAlert, Ban } from 'lucide-react';
import {
  approveReplacementForOrderAction,
  rejectReplacementForOrderAction,
  type MutationState,
} from './actions';
import type { OrderDetail } from '../../../lib/api';
import { Button } from '../../../components/ui/button';
import { Badge, StatusBadge } from '../../../components/ui/badge';
import { useAnnouncer } from '../../../components/a11y/announcer';

type Replacement = OrderDetail['replacements'][number];

function isActionable(status: string) {
  return status === 'open' || status === 'info_requested';
}

/** Sipariş ekranında değişim/destek talebi satırı — bağlamında onayla/reddet. */
function ReplacementRow({ r, orderId }: { r: Replacement; orderId: string }) {
  const [pending, startTransition] = React.useTransition();
  const [state, setState] = React.useState<MutationState | null>(null);
  const announce = useAnnouncer();

  const run = (fn: () => Promise<MutationState>) => {
    setState(null);
    startTransition(async () => {
      const res = await fn();
      setState(res);
      announce(res.ok ? (res.message ?? 'Tamam') : (res.error ?? 'İşlem başarısız'), {
        assertive: !res.ok,
      });
    });
  };

  const approve = () => {
    if (
      !window.confirm(
        'Değişim onaylansın mı?\n\nMevcut atama geri alınır ve stoktan taze bir key atanır. Stok yoksa işlem yapılmaz.',
      )
    )
      return;
    run(() => approveReplacementForOrderAction(r.id, orderId));
  };

  const reject = () => {
    const note = window.prompt('Red gerekçesi (müşteriye görünür):');
    if (note === null) return;
    if (!note.trim()) {
      announce('Red gerekçesi zorunlu', { assertive: true });
      return;
    }
    run(() => rejectReplacementForOrderAction(r.id, orderId, note));
  };

  return (
    <li className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={r.status} />
          {r.withinWarranty ? (
            <Badge variant="success">
              <ShieldCheck /> garanti içi
            </Badge>
          ) : (
            <Badge variant="warning">
              <TriangleAlert /> garanti dışı
            </Badge>
          )}
          <span className="text-xs tabular-nums text-muted-foreground">
            {new Date(r.createdAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })}
          </span>
        </div>
        <p className="text-sm text-foreground">{r.reason}</p>
        {r.resolutionNote && (
          <p className="text-xs text-muted-foreground">Çözüm notu: {r.resolutionNote}</p>
        )}
        {!r.assignmentId && isActionable(r.status) && (
          <p className="flex items-center gap-1.5 text-xs text-warning">
            <TriangleAlert className="size-3.5" /> Belirli bir lisansa bağlı değil — otomatik değişim
            yapılamaz; ilgili atamada "Değiştir" kullanın.
          </p>
        )}
        {state && (
          <p
            className={`flex items-center gap-1.5 text-xs font-medium ${
              state.ok ? 'text-success' : 'text-destructive'
            }`}
          >
            {state.ok ? (
              <CheckCircle2 className="size-3.5" />
            ) : (
              <TriangleAlert className="size-3.5" />
            )}
            {state.ok ? (state.message ?? 'Tamam') : (state.error ?? 'İşlem başarısız')}
          </p>
        )}
      </div>
      {isActionable(r.status) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={approve} disabled={pending}>
            <CheckCircle2 /> {pending ? 'İşleniyor…' : 'Onayla (değiştir)'}
          </Button>
          <Button
            type="button"
            variant="danger-outline"
            size="sm"
            onClick={reject}
            disabled={pending}
          >
            <Ban /> Reddet
          </Button>
        </div>
      )}
    </li>
  );
}

export function OrderReplacements({
  replacements,
  orderId,
}: {
  replacements: Replacement[];
  orderId: string;
}) {
  return (
    <ul className="divide-y divide-border">
      {replacements.map((r) => (
        <ReplacementRow key={r.id} r={r} orderId={orderId} />
      ))}
    </ul>
  );
}
