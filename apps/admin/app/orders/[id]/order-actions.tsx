'use client';
import * as React from 'react';
import { CheckCircle2, TriangleAlert, PauseCircle, PlayCircle, RefreshCw, Ban } from 'lucide-react';
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

/** Kompakt ikon aksiyon butonu (yer tasarrufu) — erişilebilir ad title+aria-label ile. */
function IconAction({
  title,
  onClick,
  disabled,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={danger ? 'danger-outline' : 'outline'}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="size-7 p-0"
    >
      {children}
    </Button>
  );
}

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
    // Sebep prompt'u aynı zamanda onay görevi görür (Vazgeç → iptal). Replace ile tutarlı; sebep
    // audit_log + fulfillment_events'e düşer (iade mi, dolandırıcılık mı, kusurlu key mi ayırt edilir).
    const reason = window.prompt(
      'İptal sebebi (ör. iade, dolandırıcılık, kusurlu key). Lisans karantinaya alınır ve müşteri görünümünden düşer — GERİ ALINAMAZ:',
      'iade',
    );
    if (reason === null) return; // vazgeçildi
    setState(null);
    startTransition(async () => {
      const res = await revokeAction(assignmentId, orderId, reason.trim() || 'admin iptali');
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
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        {status === 'active' && (
          <>
            <IconAction title="Askıya Al" onClick={suspend} disabled={pending}>
              <PauseCircle />
            </IconAction>
            <IconAction title="Değiştir (taze key ata)" onClick={replace} disabled={pending}>
              <RefreshCw />
            </IconAction>
            <IconAction title="İptal et / Geri al" onClick={revoke} disabled={pending} danger>
              <Ban />
            </IconAction>
          </>
        )}
        {status === 'suspended' && (
          <>
            <IconAction title="Askıdan Çıkar" onClick={unsuspend} disabled={pending}>
              <PlayCircle />
            </IconAction>
            {/* Askıdaki key doğrudan iptal edilebilir — önce müşteriye tekrar açmaya gerek yok
                (revoke suspended'ı destekler; şüpheli lisansı canlıya döndürmeden kapatılır). */}
            <IconAction title="İptal et / Geri al" onClick={revoke} disabled={pending} danger>
              <Ban />
            </IconAction>
          </>
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
