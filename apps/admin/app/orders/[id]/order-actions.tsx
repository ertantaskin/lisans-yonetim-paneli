'use client';
import * as React from 'react';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import {
  completeLineAction,
  replaceAction,
  revokeAction,
  resendAction,
  suspendAction,
  unsuspendAction,
  type MutationState,
} from './actions';
import { Button } from '../../../components/ui/button';
import { useAnnouncer } from '../../../components/a11y/announcer';

/** Mutasyon sonucunu ekran okuyucuya duyurur (WCAG 4.1.3): hata → assertive. */
function announceResult(announce: (t: string, o?: { assertive?: boolean }) => void, state: MutationState) {
  announce(state.ok ? (state.message ?? 'Tamam') : (state.error ?? 'İşlem başarısız'), {
    assertive: !state.ok,
  });
}

/**
 * Ortak inline geri bildirim. Server action fırlatmadığı için (bkz. actions.ts) hata da
 * başarı da burada gösterilir — kök error boundary sayfayı silmez.
 */
function Feedback({ state }: { state: MutationState | null }) {
  if (!state) return null;
  if (!state.ok) {
    return (
      <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
        <TriangleAlert className="size-3.5" /> {state.error ?? 'İşlem başarısız'}
      </p>
    );
  }
  return (
    <p className="flex items-center gap-1.5 text-xs font-medium text-success">
      <CheckCircle2 className="size-3.5" /> {state.message ?? 'Tamam'}
    </p>
  );
}

/** "Kalanları Ata" — kalan adedi atar; sonuç inline yüzeye çıkar (fırlatma yok). */
export function CompleteLineButton({ lineId, orderId }: { lineId: string; orderId: string }) {
  const [pending, startTransition] = React.useTransition();
  const [state, setState] = React.useState<MutationState | null>(null);
  const announce = useAnnouncer();

  const run = () => {
    setState(null);
    startTransition(async () => {
      const res = await completeLineAction(lineId, orderId);
      setState(res);
      announceResult(announce, res);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button type="button" size="sm" onClick={run} disabled={pending}>
        {pending ? 'Atanıyor…' : 'Kalanları Ata'}
      </Button>
      <Feedback state={state} />
    </div>
  );
}

/**
 * Atama moderasyon aksiyonları (askıya al / iptal / askıdan çıkar). İptal ve askıya al
 * geri-dönüşsüz/hassas olduğu için onay ister (§5); sonuç inline gösterilir.
 */
export function AssignmentActions({
  assignmentId,
  orderId,
  status,
}: {
  assignmentId: string;
  orderId: string;
  status: string;
}) {
  const [pending, startTransition] = React.useTransition();
  const [state, setState] = React.useState<MutationState | null>(null);
  const announce = useAnnouncer();

  const suspend = () => {
    if (
      !window.confirm(
        'Atama askıya alınsın mı? Müşteri görünümünde "inceleme altında" olur (geri alınabilir).',
      )
    )
      return;
    setState(null);
    startTransition(async () => {
      const res = await suspendAction(assignmentId, orderId);
      setState(res);
      announceResult(announce, res);
    });
  };

  const revoke = () => {
    if (
      !window.confirm(
        'Atama İPTAL edilsin mi? Lisans karantinaya alınır ve müşteri görünümünden düşer. Bu işlem GERİ ALINAMAZ.',
      )
    )
      return;
    setState(null);
    startTransition(async () => {
      const res = await revokeAction(assignmentId, orderId, 'iade/iptal');
      setState(res);
      announceResult(announce, res);
    });
  };

  const unsuspend = () => {
    setState(null);
    startTransition(async () => {
      const res = await unsuspendAction(assignmentId, orderId);
      setState(res);
      announceResult(announce, res);
    });
  };

  const replace = () => {
    const reason = window.prompt(
      'Değişim sebebi (ör. kusurlu key). Eski key karantinaya alınır, aynı üründen TAZE key atanır. Stok yoksa değişim yapılmaz:',
    );
    if (reason === null) return; // iptal
    if (!reason.trim()) {
      announce('Değişim sebebi zorunlu', { assertive: true });
      return;
    }
    setState(null);
    startTransition(async () => {
      const res = await replaceAction(assignmentId, orderId, reason);
      setState(res);
      announceResult(announce, res);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {status === 'active' && (
          <>
            <Button type="button" variant="outline" size="sm" onClick={suspend} disabled={pending}>
              Askıya Al
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={replace} disabled={pending}>
              Değiştir
            </Button>
            <Button
              type="button"
              variant="danger-outline"
              size="sm"
              onClick={revoke}
              disabled={pending}
            >
              İptal
            </Button>
          </>
        )}
        {status === 'suspended' && (
          <Button type="button" variant="outline" size="sm" onClick={unsuspend} disabled={pending}>
            Askıdan Çıkar
          </Button>
        )}
      </div>
      <Feedback state={state} />
    </div>
  );
}

/** Teslimat mailini yeniden gönder — başarı/hata/çok-sık durumu inline yüzeye çıkar (§17). */
export function ResendButton({ orderId }: { orderId: string }) {
  const [pending, startTransition] = React.useTransition();
  const [state, setState] = React.useState<MutationState | null>(null);
  const announce = useAnnouncer();

  const run = () => {
    setState(null);
    startTransition(async () => {
      const res = await resendAction(orderId);
      setState(res);
      announceResult(announce, res);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button type="button" variant="outline" size="sm" onClick={run} disabled={pending}>
        {pending ? 'Gönderiliyor…' : 'Maili Yeniden Gönder'}
      </Button>
      <Feedback state={state} />
    </div>
  );
}
