import * as React from 'react';
import { cn } from '../../lib/utils';

/**
 * Hafif avatar (radix dep gerektirmez): görsel yoksa baş harf(ler)i gösterir.
 * shadcn-admin nav-user/footer için yeterli.
 */
export function Avatar({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-secondary text-secondary-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function AvatarImage({
  className,
  alt = '',
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement>) {
  if (!props.src) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img alt={alt} className={cn('size-full object-cover', className)} {...props} />;
}

export function AvatarFallback({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn('text-xs font-semibold uppercase', className)} {...props} />
  );
}

/** İsimden baş harf üretir ("Ali Veli" → "AV"). */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}
