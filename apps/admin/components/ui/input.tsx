import * as React from 'react';
import { cn } from '../../lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'h-9 w-full rounded-[var(--radius-md)] border border-border bg-surface-raised px-3 text-sm text-ink shadow-sm outline-none transition-colors',
        'placeholder:text-muted/70 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'w-full rounded-[var(--radius-md)] border border-border bg-surface-raised px-3 py-2 text-sm text-ink shadow-sm outline-none transition-colors',
      'placeholder:text-muted/70 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('text-xs font-medium text-ink/70', className)}
      {...props}
    />
  );
}
