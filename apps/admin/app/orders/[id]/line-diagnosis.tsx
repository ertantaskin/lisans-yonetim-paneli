'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  Ban,
  CalendarClock,
  CheckCircle2,
  HelpCircle,
  Link2,
  PackagePlus,
  ShieldAlert,
  ShieldQuestion,
  TriangleAlert,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
import { resolvePendingAction, type MutationState } from './actions';
import { Button } from '../../../components/ui/button';
import { useAnnouncer } from '../../../components/a11y/announcer';
import { diagnosisReasonLabel } from '../../../lib/labels';
import { cn } from '../../../lib/utils';

/**
 * "Neden bekliyor" tanı şeridi (§13).
 *
 * Kullanıcı geri bildirimi: "eşledim ama sipariş hâlâ eşlenmemiş görünüyor; 'Kalanları Ata'
 * diyorum 'atanacak bir şey yok' diyor — bekleyen satır muhabbeti çok saçma". Çözüm: satırın
 * NEDEN beklediğini backend tanılar (`GET /v1/admin/pending-lines/diagnose/:orderId`), burada
 * tek cümle sebep + tek cümle "ne yapmalı" + TEK TIK aksiyon olarak gösterilir. Operatör artık
 * tahmin etmez; ekran hangi düğmeye basacağını söyler.
 *
 * Tanı OPSİYONEL bir katmandır: uç hata verirse sayfa eski davranışıyla tam çalışır.
 */

// ── Backend kontratı (apps/api/src/orders/pending-lines.service.ts) ───────────
// Tipler burada tekrar tanımlanır; lib/api.ts merkezî sözlüğe ait olduğu için (paralel işçi)
// bu ekranın ihtiyacı yerelde durur. Alan adları backend ile BİREBİR aynıdır.

export type LineDiagnosisReason =
  | 'ok'
  | 'canceled'
  | 'no-remote-id'
  | 'unmapped'
  | 'mapping-available'
  | 'held'
  | 'preorder'
  | 'out-of-stock'
  | 'ready';

export type LineDiagnosisAction = 'none' | 'map' | 'resolve' | 'review' | 'stock' | 'complete';

export interface LineDiagnosis {
  lineId: string;
  remoteLineId: string;
  remoteProductId: string | null;
  remoteVariationId: string | null;
  remoteName: string | null;
  productId: string | null;
  productName: string | null;
  qty: number;
  fulfilledQty: number;
  status: string;
  canceled: boolean;
  reason: LineDiagnosisReason;
  action: LineDiagnosisAction;
  message: string;
  availableStock: number | null;
}

export interface OrderDiagnosis {
  orderId: string;
  remoteOrderId: string;
  siteId: string;
  siteDomain: string;
  heldForReview: boolean;
  resolvableCount: number;
  lines: LineDiagnosis[];
}

// ── Sebep → ikon/ton ─────────────────────────────────────────────────────────
// METİN burada DEĞİL: Türkçe başlık `lib/labels.ts` → `diagnosisReasonLabel` (tek kaynak).
// Burada yalnız GÖRSEL eşleme (ikon + ton) durur — o merkezî sözlüğün işi değil.
type Tone = 'ok' | 'warn' | 'action' | 'muted';

const REASON_META: Record<LineDiagnosisReason, { icon: LucideIcon; tone: Tone }> = {
  ok: { icon: CheckCircle2, tone: 'ok' },
  ready: { icon: CheckCircle2, tone: 'ok' },
  'mapping-available': { icon: Wand2, tone: 'action' },
  unmapped: { icon: ShieldAlert, tone: 'warn' },
  'no-remote-id': { icon: ShieldQuestion, tone: 'warn' },
  held: { icon: ShieldAlert, tone: 'warn' },
  'out-of-stock': { icon: TriangleAlert, tone: 'warn' },
  preorder: { icon: CalendarClock, tone: 'muted' },
  canceled: { icon: Ban, tone: 'muted' },
};

const TONE_BOX: Record<Tone, string> = {
  ok: 'border-success/40 bg-success/10',
  warn: 'border-warning/50 bg-warning/10',
  action: 'border-border bg-accent/60',
  muted: 'border-border bg-muted/40',
};

const TONE_ICON: Record<Tone, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  action: 'text-foreground',
  muted: 'text-muted-foreground',
};

/** Aksiyon sonucunu inline gösterir (server action ASLA fırlatmaz — bkz. actions.ts). */
function Feedback({ state }: { state: MutationState | null }) {
  if (!state) return null;
  return (
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
  );
}

/**
 * "Eşlemeyi Uygula" — operatörün SONRADAN yaptığı eşlemeyi bu satıra/siparişe geriye dönük
 * uygular ve teslimatı dener. Yeni eşleme OLUŞTURMAZ (otomatik eşleştirme yok, §3).
 * Sonuç sayıları (bağlandı/teslim edildi/hâlâ bekliyor) dürüstçe yüzeye çıkar.
 */
export function ResolveMappingButton({
  orderId,
  lineId,
  label = 'Eşlemeyi Uygula',
  variant = 'default',
  className,
}: {
  orderId: string;
  lineId?: string;
  label?: string;
  variant?: 'default' | 'outline';
  className?: string;
}) {
  const [pending, startTransition] = React.useTransition();
  const [state, setState] = React.useState<MutationState | null>(null);
  const announce = useAnnouncer();

  const run = () => {
    setState(null);
    startTransition(async () => {
      const res = await resolvePendingAction(orderId, lineId);
      setState(res);
      announce(res.ok ? (res.message ?? 'Tamam') : (res.error ?? 'İşlem başarısız'), {
        assertive: !res.ok,
      });
    });
  };

  return (
    <div className={cn('flex flex-col items-start gap-1.5', className)}>
      <Button type="button" size="sm" variant={variant} onClick={run} disabled={pending}>
        <Wand2 aria-hidden />
        {pending ? 'Uygulanıyor…' : label}
      </Button>
      <Feedback state={state} />
    </div>
  );
}

/**
 * Sipariş düzeyi bilgi bandı: "N satır artık eşlenmiş — tek tıkla teslimata alın".
 * Kullanıcının "eşledim ama hâlâ eşlenmemiş görünüyor" şikâyetinin doğrudan cevabı.
 */
export function OrderResolveBanner({ orderId, count }: { orderId: string; count: number }) {
  if (count <= 0) return null;
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-accent/60 px-4 py-3 text-sm">
      <Wand2 className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium text-foreground">
          Bu siparişte <strong className="tabular-nums">{count}</strong> satır artık eşlenmiş
          durumda.
        </p>
        <p className="text-xs text-muted-foreground">
          Satırlar eşleme yapılmadan ÖNCE geldiği için ürüne bağlı değil. “Eşlemeyi Uygula”
          mevcut eşlemeyi bu satırlara uygular ve teslimatı dener (yeni eşleme oluşturmaz).
        </p>
      </div>
      <ResolveMappingButton orderId={orderId} label="Eşlemeyi Uygula" />
    </div>
  );
}

/**
 * Tek satırın tanı şeridi: sebep + ne yapmalı + tek tık aksiyon.
 * `action === 'complete'` durumunda ayrı düğme basılmaz — kart başlığındaki "Kalanları Ata"
 * düğmesi zaten oradadır (çift düğme kafa karıştırır); şerit yalnız yönlendirir.
 */
export function LineDiagnosisStrip({
  diagnosis,
  orderId,
  siteId,
  fallbackTitle,
  fallbackMessage,
}: {
  diagnosis: LineDiagnosis | null;
  orderId: string;
  siteId: string | null;
  /** Tanı ucu erişilemezse detail() `pendingReason` alanından gelen yedek metinler. */
  fallbackTitle?: string | null;
  fallbackMessage?: string | null;
}) {
  // Tanı yoksa yedek (detail.pendingReason) ile sade bir şerit; o da yoksa hiç gösterme.
  if (!diagnosis) {
    if (!fallbackTitle) return null;
    return (
      <div
        className={cn(
          'flex flex-wrap items-start gap-2.5 border-t px-4 py-2.5 text-sm',
          TONE_BOX.warn,
        )}
      >
        <HelpCircle className={cn('mt-0.5 size-4 shrink-0', TONE_ICON.warn)} aria-hidden />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="font-medium text-foreground">Neden bekliyor: {fallbackTitle}</p>
          {fallbackMessage && <p className="text-xs text-muted-foreground">{fallbackMessage}</p>}
        </div>
      </div>
    );
  }

  // Tamamlanmış satırda şerit gürültü yapar — kart başlığındaki durum rozeti yeterli.
  if (diagnosis.reason === 'ok') return null;

  const meta = REASON_META[diagnosis.reason] ?? REASON_META.unmapped;
  const Icon = meta.icon;

  return (
    <div
      className={cn(
        'flex flex-wrap items-start gap-2.5 border-t px-4 py-2.5 text-sm',
        TONE_BOX[meta.tone],
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', TONE_ICON[meta.tone])} aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium text-foreground">
          Neden bekliyor: {diagnosisReasonLabel(diagnosis.reason)}
        </p>
        <p className="text-xs text-muted-foreground">{diagnosis.message}</p>
        {diagnosis.availableStock != null && diagnosis.reason === 'out-of-stock' && (
          <p className="text-xs tabular-nums text-muted-foreground">
            Kullanılabilir stok: <strong>{diagnosis.availableStock}</strong> · gereken:{' '}
            <strong>{Math.max(diagnosis.qty - diagnosis.fulfilledQty, 0)}</strong>
          </p>
        )}
      </div>

      <div className="shrink-0">
        {diagnosis.action === 'resolve' && (
          <ResolveMappingButton orderId={orderId} lineId={diagnosis.lineId} />
        )}
        {diagnosis.action === 'map' && (
          <Button asChild size="sm" variant="outline">
            <Link href={siteId ? `/mappings?site=${siteId}` : '/mappings'}>
              <Link2 aria-hidden /> Ürünü Eşle
            </Link>
          </Button>
        )}
        {diagnosis.action === 'review' && (
          <Button asChild size="sm" variant="outline">
            <Link href="/review">
              <ShieldAlert aria-hidden /> İnceleme Kuyruğu
            </Link>
          </Button>
        )}
        {diagnosis.action === 'stock' && diagnosis.productId && (
          // Panelin standart "stok gir" derin bağlantısı `/stock/import?product=<id>`
          // (bkz. app/pending/page.tsx, app/products/[id]/page.tsx, components/batches-table.tsx).
          // Eskiden ürün DETAY sayfasına gidiyordu: operatör "Stok Gir" deyip stok formu yerine
          // ürün özetine düşüyor, tek tık vaadi bozuluyordu.
          <Button asChild size="sm" variant="outline">
            <Link href={`/stock/import?product=${diagnosis.productId}`}>
              <PackagePlus aria-hidden /> Stok Gir
            </Link>
          </Button>
        )}
        {diagnosis.action === 'complete' && (
          <span className="text-xs text-muted-foreground">
            Yukarıdaki “Kalanları Ata” düğmesini kullanın.
          </span>
        )}
      </div>
    </div>
  );
}
