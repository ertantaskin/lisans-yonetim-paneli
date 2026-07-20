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
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
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

// ── Durum → renk/etiket/ikon (§17: tek durum dili, pill+ikon) ────────────────
type StatusMeta = { variant: NonNullable<BadgeProps['variant']>; label: string; icon: LucideIcon };

const STATUS: Record<string, StatusMeta> = {
  fulfilled: { variant: 'success', label: 'teslim edildi', icon: CheckCircle2 },
  active: { variant: 'success', label: 'aktif', icon: CheckCircle2 },
  sent: { variant: 'success', label: 'gönderildi', icon: Mail },
  delivered: { variant: 'success', label: 'iletildi', icon: CheckCircle2 },
  partial: { variant: 'warning', label: 'kısmi', icon: Clock },
  pending: { variant: 'warning', label: 'bekliyor', icon: Clock },
  // Değişim/garanti talepleri (§13).
  open: { variant: 'warning', label: 'açık', icon: Clock },
  info_requested: { variant: 'warning', label: 'bilgi istendi', icon: Mail },
  approved: { variant: 'success', label: 'onaylandı', icon: CheckCircle2 },
  rejected: { variant: 'danger', label: 'reddedildi', icon: Ban },
  queued: { variant: 'warning', label: 'kuyrukta', icon: Loader2 },
  suspended: { variant: 'warning', label: 'askıda', icon: PauseCircle },
  expired: { variant: 'warning', label: 'süresi doldu', icon: Clock },
  unmapped: { variant: 'danger', label: 'eşlenmemiş', icon: ShieldAlert },
  revoked: { variant: 'danger', label: 'iptal', icon: Ban },
  failed: { variant: 'danger', label: 'başarısız', icon: AlertTriangle },
  bounced: { variant: 'danger', label: 'geri döndü', icon: AlertTriangle },
  quarantined: { variant: 'danger', label: 'karantina', icon: ShieldAlert },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const meta = STATUS[status] ?? { variant: 'neutral' as const, label: status, icon: Clock };
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className={className}>
      <Icon />
      {meta.label}
    </Badge>
  );
}
