import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'neutral';

const toneChip: Record<Tone, string> = {
  accent: 'bg-accent-soft text-accent',
  success: 'bg-[color-mix(in_srgb,var(--color-success)_14%,transparent)] text-success',
  warning: 'bg-[color-mix(in_srgb,var(--color-warning)_16%,transparent)] text-warning',
  danger: 'bg-[color-mix(in_srgb,var(--color-danger)_14%,transparent)] text-danger',
  neutral: 'bg-ink/[0.06] text-ink/70',
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
        'rounded-[var(--radius-card)] border border-border bg-surface-raised p-4 shadow-sm',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            {label}
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-ink">{value}</div>
          {hint && <div className="mt-0.5 truncate text-xs text-muted">{hint}</div>}
        </div>
        <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)]', toneChip[tone])}>
          <Icon className="size-4.5" />
        </span>
      </div>
    </div>
  );
}
