import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'neutral';

// Dolgu TEK KAYNAK: rozetle AYNI `--<hue>-fill` token'ı (eskiden burada %14/%16 elle
// kopyalanmıştı ve rozetlerden bir tık daha sönüktü — aynı ekranda iki farklı yeşil).
const toneChip: Record<Tone, string> = {
  accent: 'bg-accent text-accent-foreground',
  success: 'bg-(--success-fill) text-success',
  warning: 'bg-(--warning-fill) text-warning',
  danger: 'bg-(--destructive-fill) text-destructive',
  neutral: 'bg-muted text-foreground/70',
};

export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'neutral',
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon: LucideIcon;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card p-5 shadow-xs',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Referans metrik kartı: etiket normal cümle düzeninde 14px muted, değer 24px/600.
              Eskiden etiket 11px BÜYÜK HARF idi (daha "pano" değil "rapor" havası veriyordu). */}
          <div className="text-sm font-medium text-muted-foreground">{label}</div>
          <div className="mt-1.5 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
          {hint && <div className="mt-1 truncate text-xs text-muted-foreground">{hint}</div>}
        </div>
        <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-full', toneChip[tone])}>
          <Icon className="size-4.5" />
        </span>
      </div>
    </div>
  );
}

// ── İnce özet şeridi (StatStrip) ─────────────────────────────────────────────
// Büyük StatTile ızgaralarının yer-tasarruflu alternatifi: tek satırda ikon +
// etiket + değer. Sipariş detayındaki özet şeridiyle aynı görsel dil (§17) —
// bir sayfada 3+ metriği başlık altında yığmak yerine tek bar'da göster.
type StripTone = 'default' | 'success' | 'warning' | 'danger';

const stripToneText: Record<StripTone, string> = {
  default: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
};

export interface StatStripItem {
  icon?: LucideIcon;
  label: string;
  value: React.ReactNode;
  /** Değerden sonra küçük gri ek (ör. "adet", "TL"). */
  hint?: string;
  tone?: StripTone;
}

export function StatStrip({ items, className }: { items: StatStripItem[]; className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-border bg-card px-4 py-2.5 text-sm shadow-xs',
        className,
      )}
    >
      {items.map((it, i) => {
        const Icon = it.icon;
        const toneCls = it.tone ? stripToneText[it.tone] : 'text-foreground';
        return (
          <span key={i} className="inline-flex items-center gap-1.5">
            {Icon && (
              <Icon className={cn('size-4', it.tone ? stripToneText[it.tone] : 'text-muted-foreground')} />
            )}
            <span className="text-muted-foreground">{it.label}</span>
            <strong className={cn('tabular-nums', toneCls)}>{it.value}</strong>
            {it.hint && <span className="text-xs text-muted-foreground">{it.hint}</span>}
          </span>
        );
      })}
    </div>
  );
}
