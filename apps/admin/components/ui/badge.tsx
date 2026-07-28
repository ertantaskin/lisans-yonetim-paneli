import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  Ban,
  PauseCircle,
  Mail,
  Loader2,
  RefreshCw,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import { badgeStatusLabel } from '../../lib/labels';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium [&_svg]:size-3',
  {
    variants: {
      variant: {
        neutral: 'bg-secondary text-secondary-foreground',
        accent: 'bg-secondary text-foreground',
        success: 'bg-[color-mix(in_oklch,var(--success)_16%,transparent)] text-success',
        warning: 'bg-[color-mix(in_oklch,var(--warning)_18%,transparent)] text-warning',
        danger: 'bg-[color-mix(in_oklch,var(--destructive)_15%,transparent)] text-destructive',
        outline: 'border border-border text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

// ── Durum → renk/ikon (§17: tek durum dili, pill+ikon) ───────────────────────
// METİN burada DEĞİL: Türkçe etiket `lib/labels.ts` → `badgeStatusLabel` (TEK KAYNAK).
// Burada yalnız GÖRSEL eşleme (renk varyantı + ikon) durur.
type StatusMeta = { variant: NonNullable<BadgeProps['variant']>; icon: LucideIcon };

const STATUS: Record<string, StatusMeta> = {
  fulfilled: { variant: 'success', icon: CheckCircle2 },
  active: { variant: 'success', icon: CheckCircle2 },
  sent: { variant: 'success', icon: Mail },
  delivered: { variant: 'success', icon: CheckCircle2 },
  partial: { variant: 'warning', icon: Clock },
  pending: { variant: 'warning', icon: Clock },
  held_for_review: { variant: 'warning', icon: ShieldAlert },
  // Değişim/garanti talepleri (§13).
  open: { variant: 'warning', icon: Clock },
  info_requested: { variant: 'warning', icon: Mail },
  approved: { variant: 'success', icon: CheckCircle2 },
  rejected: { variant: 'danger', icon: Ban },
  queued: { variant: 'warning', icon: Loader2 },
  suspended: { variant: 'warning', icon: PauseCircle },
  expired: { variant: 'warning', icon: Clock },
  unmapped: { variant: 'danger', icon: ShieldAlert },
  revoked: { variant: 'danger', icon: Ban },
  replaced: { variant: 'neutral', icon: RefreshCw },
  canceled: { variant: 'neutral', icon: Ban },
  failed: { variant: 'danger', icon: AlertTriangle },
  bounced: { variant: 'danger', icon: AlertTriangle },
  quarantined: { variant: 'danger', icon: ShieldAlert },
  voided: { variant: 'danger', icon: Ban },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const meta = STATUS[status] ?? { variant: 'neutral' as const, icon: Clock };
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className={className}>
      <Icon />
      {badgeStatusLabel(status)}
    </Badge>
  );
}
