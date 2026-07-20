import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

/**
 * Semantik uyarı yüzeyi (shadcn Alert deseni) — tek kanonik color-mix uzayı (oklch) ve opaklık.
 * İkon + başlık + açıklama; gövde metni her zaman text-foreground (AA), aksan yalnız ikon/başlıkta.
 */
const alertVariants = cva(
  'relative flex w-full gap-3 rounded-lg border p-4 text-sm [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:translate-y-0.5',
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-foreground [&>svg]:text-muted-foreground',
        info: 'border-border bg-muted/50 text-foreground [&>svg]:text-muted-foreground',
        success:
          'border-success/40 bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-foreground [&>svg]:text-success',
        warning:
          'border-warning/40 bg-[color-mix(in_oklch,var(--warning)_12%,transparent)] text-foreground [&>svg]:text-warning',
        destructive:
          'border-destructive/40 bg-[color-mix(in_oklch,var(--destructive)_10%,transparent)] text-foreground [&>svg]:text-destructive',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Alert({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

export function AlertTitle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-1 font-medium', className)} {...props} />;
}

export function AlertDescription({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-sm text-foreground/80 [&_p]:leading-relaxed', className)} {...props} />;
}
