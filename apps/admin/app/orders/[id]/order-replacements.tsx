'use client';
import * as React from 'react';
import {
  CheckCircle2,
  ChevronRight,
  KeyRound,
  Mail,
  ShieldCheck,
  TriangleAlert,
  Ban,
} from 'lucide-react';
import {
  approveReplacementForOrderAction,
  rejectReplacementForOrderAction,
  type MutationState,
} from './actions';
// MAK gate metni TEK KAYNAK: atama aksiyonlarıyla aynı kural, aynı reçete (iki ekranda
// çelişen açıklama üretmemek için kopyalanmadı).
import { MULTI_REPLACE_BLOCKED } from './order-actions';
import { Button } from '../../../components/ui/button';
import { Badge, StatusBadge } from '../../../components/ui/badge';
import { useConfirm } from '../../../components/ui/confirm';
import { SupportThread } from '../../../components/support/support-thread';
import { useAnnouncer } from '../../../components/a11y/announcer';
import { supportStatusLabel } from '../../../lib/labels';
import { cn } from '../../../lib/utils';

/** Sipariş detayının bildiği talep alanları (lib/api.ts OrderDetail.replacements ile uyumlu). */
export interface OrderReplacement {
  id: string;
  status: string;
  reason: string;
  withinWarranty: boolean;
  resolutionNote: string | null;
  lineId: string | null;
  assignmentId: string | null;
  createdAt: string;
  /**
   * Talebin ürününün kullanım modu (`single` | `multi`) — backend `detail()` talebin
   * satırından/atamasından çözer. `multi` (MAK) ise "Onayla (değiştir)" ucu 400 döner,
   * bu yüzden düğme kapatılır. Alan gelmezse (eski API imajı) gate uygulanmaz.
   */
  usageMode?: string | null;
}

function isActionable(status: string) {
  return status === 'open' || status === 'info_requested';
}

/**
 * Sipariş ekranındaki destek/değişim talebi — AÇILABİLİR satır.
 *
 * Kullanıcı geri bildirimi: "admin tarafında cevap verme şansımız olmuyor; değişim olayı çok
 * alakasız yerde, siparişin içinde olsa daha iyi". Bu yüzden talep açıldığında yazışma
 * (SupportThread) siparişin İÇİNDE render edilir; Onayla/Reddet düğmeleri aynı yerde kalır.
 */
function ReplacementRow({
  r,
  orderId,
  customerEmail,
  licenseLabel,
}: {
  r: OrderReplacement;
  orderId: string;
  customerEmail: string | null;
  /** Talebin bağlı olduğu atamanın okunabilir özeti (varsa). */
  licenseLabel: string | null;
}) {
  const [pending, startTransition] = React.useTransition();
  const [state, setState] = React.useState<MutationState | null>(null);
  // Aksiyon bekleyen talepler açık başlar (operatör tıklamadan görsün); çözülmüşler kapalı.
  const [open, setOpen] = React.useState(isActionable(r.status));
  const announce = useAnnouncer();
  const { confirm, dialog } = useConfirm();
  // Çok kullanımlı (MAK) üründe otomatik değişim YOK — bkz. MULTI_REPLACE_BLOCKED.
  const multiBlocked = r.usageMode === 'multi';

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

  const approve = async () => {
    const ok = await confirm({
      title: 'Değişim onaylansın mı?',
      description:
        'Mevcut atama geri alınır ve stoktan TAZE bir kalem atanır. Stok yoksa işlem yapılmaz — eskisi yerinde kalır.',
      confirmLabel: 'Onayla ve değiştir',
    });
    if (!ok) return;
    run(() => approveReplacementForOrderAction(r.id, orderId));
  };

  const reject = async () => {
    const res = await confirm({
      title: 'Değişim talebi reddedilsin mi?',
      description: 'Müşteriye red bildirimi gider; mevcut lisans aynen kalır.',
      tone: 'danger',
      confirmLabel: 'Reddet',
      reason: {
        label: 'Red gerekçesi',
        placeholder: 'ör. garanti süresi dolmuş',
        required: true,
        hint: 'Bu metin MÜŞTERİYE görünür.',
      },
    });
    if (!res) return;
    run(() => rejectReplacementForOrderAction(r.id, orderId, res.reason));
  };

  const created = new Date(r.createdAt).toLocaleString('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  return (
    <li className={cn('p-3', isActionable(r.status) && 'bg-warning/5')}>
      {dialog}
      <details className="group" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="flex cursor-pointer list-none items-start gap-2">
          <ChevronRight
            className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
            aria-hidden
          />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge status={r.status} />
              {r.withinWarranty ? (
                <Badge variant="success">
                  <ShieldCheck aria-hidden /> Garanti içi
                </Badge>
              ) : (
                <Badge variant="warning">
                  <TriangleAlert aria-hidden /> garanti dışı
                </Badge>
              )}
            </div>
            <p className="truncate text-sm text-foreground" title={r.reason}>
              {r.reason}
            </p>
            <p className="text-xs tabular-nums text-muted-foreground">
              {supportStatusLabel(r.status)} · {created}
            </p>
          </div>
        </summary>

        {/* ── Açılan gövde: bağlam + aksiyonlar + yazışma ── */}
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <dl className="space-y-1 text-xs">
            {customerEmail && (
              <div className="flex items-start gap-1.5">
                <dt className="sr-only">Müşteri</dt>
                <Mail className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <dd className="min-w-0 break-all text-foreground" title={customerEmail}>
                  {customerEmail}
                </dd>
              </div>
            )}
            {licenseLabel && (
              <div className="flex items-start gap-1.5">
                <dt className="sr-only">İlgili lisans</dt>
                <KeyRound className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <dd className="min-w-0 text-foreground" title={licenseLabel}>
                  {licenseLabel}
                </dd>
              </div>
            )}
          </dl>

          <p className="whitespace-pre-wrap break-words text-sm text-foreground">{r.reason}</p>

          {r.resolutionNote && (
            <p className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
              Çözüm notu: <span className="text-foreground">{r.resolutionNote}</span>
            </p>
          )}

          {/* MAK (multi): "Onayla" değişim makinesini çalıştırır ve API 400 döner. Sebep +
              GERÇEK reçete burada yazılır; düğme aşağıda devre dışı kalır. */}
          {multiBlocked && isActionable(r.status) && (
            <p className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{MULTI_REPLACE_BLOCKED}</span>
            </p>
          )}

          {!r.assignmentId && isActionable(r.status) && (
            <p className="flex items-start gap-1.5 text-xs text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Belirli bir lisansa bağlı değil — otomatik değişim yapılamaz; ilgili atamada
              “Değiştir” düğmesini kullanın.
            </p>
          )}

          {state && (
            <p
              className={cn(
                'flex items-start gap-1.5 text-xs font-medium',
                state.ok ? 'text-success' : 'text-destructive',
              )}
            >
              {state.ok ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              ) : (
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              )}
              <span>{state.ok ? (state.message ?? 'Tamam') : (state.error ?? 'İşlem başarısız')}</span>
            </p>
          )}

          {isActionable(r.status) && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => void approve()}
                // MAK'ta uç 400 verir → düğme hiç tıklanabilir olmasın. "Reddet" AÇIK kalır:
                // operatörün talebi bir açıklamayla kapatabilmesi gerekir.
                disabled={pending || multiBlocked}
                title={multiBlocked ? MULTI_REPLACE_BLOCKED : undefined}
                aria-label={multiBlocked ? `Onayla (değiştir) — ${MULTI_REPLACE_BLOCKED}` : undefined}
              >
                <CheckCircle2 aria-hidden /> {pending ? 'İşleniyor…' : 'Onayla (değiştir)'}
              </Button>
              <Button
                type="button"
                variant="danger-outline"
                size="sm"
                onClick={() => void reject()}
                disabled={pending}
              >
                <Ban aria-hidden /> Reddet
              </Button>
            </div>
          )}

          {/* Yazışma: müşteriye yanıt + iç not — siparişin içinden (kullanıcı isteği).
              Yalnız AÇIKKEN monte edilir: kapalı talepler sayfa açılışında gereksiz istek atmaz. */}
          {open && <SupportThread requestId={r.id} orderId={orderId} compact />}
        </div>
      </details>
    </li>
  );
}

export function OrderReplacements({
  replacements,
  orderId,
  customerEmail = null,
  licenseLabels,
}: {
  replacements: OrderReplacement[];
  orderId: string;
  customerEmail?: string | null;
  /** assignmentId → okunabilir lisans özeti (sunucuda hesaplanır; sır içermez). */
  licenseLabels?: Record<string, string>;
}) {
  return (
    <ul className="divide-y divide-border">
      {replacements.map((r) => (
        <ReplacementRow
          key={r.id}
          r={r}
          orderId={orderId}
          customerEmail={customerEmail}
          licenseLabel={
            r.assignmentId ? (licenseLabels?.[r.assignmentId] ?? null) : null
          }
        />
      ))}
    </ul>
  );
}
