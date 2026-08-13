'use client';
import * as React from 'react';
import { cn } from '../../lib/utils';

/**
 * Seçim kutusu — NATIVE `<input type="checkbox">` üzerine ince bir stil katmanı.
 *
 * NEDEN Radix DEĞİL: projede `@radix-ui/react-checkbox` bağımlılığı yok ve tek ihtiyacımız
 * olan davranışı (klavye, form, `indeterminate`, ekran okuyucu) tarayıcı zaten doğru veriyor.
 * Yeni bir paket + lockfile değişikliği getirmenin karşılığı yok. `accent-color` ile tema
 * rengine bağlanır; odak halkası panelin geri kalanıyla aynı.
 *
 * `indeterminate` yalnız DOM property'sidir (HTML özniteliği yok) → ref ile yazılır.
 */
export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  indeterminate?: boolean;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, indeterminate = false, ...props },
  forwardedRef,
) {
  const innerRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      type="checkbox"
      ref={(node) => {
        innerRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }}
      className={cn(
        'size-4 shrink-0 cursor-pointer rounded border-border accent-[var(--primary)]',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
      {...props}
    />
  );
});
