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
import { useConfirm } from '../../../components/ui/confirm';
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
 *
 * `siblingActiveCount`: AYNI sipariş kalemindeki DİĞER canlı (aktif|askıda) atama sayısı.
 * Yalnız SUNUM içindir — iptal onayının ne vaat ettiğini backend davranışına hizalar:
 * kardeş varsa satır terminal YAPILMAZ (yalnız bu birim iptal edilir, müşterinin diğer
 * lisansları çalışmaya devam eder); kardeş yoksa satırın tamamı iptal işaretlenir.
 * Sayı bilinmiyorsa (prop verilmedi) eski, tek dallı metin korunur.
 */
export function AssignmentActions({
  assignmentId,
  orderId,
  status,
  siblingActiveCount,
}: {
  assignmentId: string;
  orderId: string;
  status: string;
  siblingActiveCount?: number;
}) {
  const [pending, startTransition] = React.useTransition();
  const [state, setState] = React.useState<MutationState | null>(null);
  const announce = useAnnouncer();
  const { confirm, dialog } = useConfirm();

  const suspend = async () => {
    const ok = await confirm({
      title: 'Atama askıya alınsın mı?',
      description:
        'Müşteri görünümünde "inceleme altında" olur ve lisans geçici olarak kullanılamaz. Bu işlem geri alınabilir ("Askıdan Çıkar").',
      confirmLabel: 'Askıya al',
    });
    if (!ok) return;
    setState(null);
    startTransition(async () => {
      const res = await suspendAction(assignmentId, orderId);
      setState(res);
      announceResult(announce, res);
    });
  };

  const revoke = async () => {
    // Sebep zorunlu DEĞİL (boşsa "admin iptali" yazılır) ama modal onay görevi de görür.
    // Sebep audit_log + fulfillment_events'e düşer → iade mi, dolandırıcılık mı, kusurlu key
    // mi sonradan ayırt edilebilir.
    //
    // Metin backend davranışına göre DALLANIR (eskiden her durumda "satır iptal işaretlenir"
    // deniyordu; kardeş lisans varken bu GERÇEKLEŞMİYOR ve operatöre yanlış söz veriliyordu).
    const siblings = siblingActiveCount ?? 0;
    const hasSiblings = siblings > 0;
    const res0 = await confirm({
      title: hasSiblings ? 'Bu lisans iptal edilsin mi?' : 'Lisans iptal edilsin mi?',
      description: hasSiblings
        ? 'Yalnız bu kalem karantinaya alınır ve müşterinin görünümünden düşer. GERİ ALINAMAZ.'
        : 'Lisans karantinaya alınır, müşteri görünümünden düşer ve sipariş satırı iptal işaretlenir. GERİ ALINAMAZ.',
      details: hasSiblings
        ? [
            `Aynı ürün kaleminde ${siblings} lisans daha var — bunlar geçerli kalmaya devam eder, müşteri kullanmayı sürdürür.`,
            'Sipariş satırı iptal (terminal) İŞARETLENMEZ; yalnız bu birim kadar kapatılır.',
          ]
        : [
            'Bu kalemde başka canlı lisans yok — sipariş satırının tamamı iptal (terminal) işaretlenir.',
            'Terminal satıra sonradan taze lisans atanmaz (iade edilen kalem yeniden teslim edilmez).',
          ],
      tone: 'danger',
      confirmLabel: 'İptal et',
      reason: {
        label: 'İptal sebebi',
        placeholder: 'ör. iade, dolandırıcılık, kusurlu key',
        hint: 'Boş bırakılırsa "admin iptali" yazılır. Sebep denetim kaydına düşer.',
      },
    });
    if (!res0) return;
    setState(null);
    startTransition(async () => {
      const res = await revokeAction(assignmentId, orderId, res0.reason || 'admin iptali');
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

  const replace = async () => {
    const res0 = await confirm({
      title: 'Lisans kalemi değiştirilsin mi?',
      description:
        'Mevcut kalem (anahtar/hesap/kod) karantinaya alınır ve aynı üründen TAZE bir kalem atanır. Stok yoksa değişim yapılmaz (eskisi yerinde kalır).',
      confirmLabel: 'Değiştir',
      reason: {
        label: 'Değişim sebebi',
        placeholder: 'ör. kusurlu key, aktivasyon hatası',
        required: true,
        hint: 'Sebep zorunlu — değişim geçmişine ve denetim kaydına yazılır.',
      },
    });
    if (!res0) return;
    setState(null);
    startTransition(async () => {
      const res = await replaceAction(assignmentId, orderId, res0.reason);
      setState(res);
      announceResult(announce, res);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      {dialog}
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {status === 'active' && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void suspend()}
              disabled={pending}
            >
              <PauseCircle /> Askıya Al
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void replace()}
              disabled={pending}
            >
              <RefreshCw /> Değiştir
            </Button>
            <Button
              type="button"
              variant="danger-outline"
              size="sm"
              onClick={() => void revoke()}
              disabled={pending}
            >
              <Ban /> İptal
            </Button>
          </>
        )}
        {status === 'suspended' && (
          <>
            <Button type="button" variant="outline" size="sm" onClick={unsuspend} disabled={pending}>
              <PlayCircle /> Askıdan Çıkar
            </Button>
            {/* Askıdaki key doğrudan iptal edilebilir — önce müşteriye tekrar açmaya gerek yok
                (revoke suspended'ı destekler; şüpheli lisansı canlıya döndürmeden kapatılır). */}
            <Button
              type="button"
              variant="danger-outline"
              size="sm"
              onClick={() => void revoke()}
              disabled={pending}
            >
              <Ban /> İptal
            </Button>
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
