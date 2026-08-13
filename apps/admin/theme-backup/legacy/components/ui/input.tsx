import * as React from 'react';
import { cn } from '../../lib/utils';

/**
 * Form kontrolü ortak taban stili (Input / Textarea / native select TEK kaynaktan beslenir —
 * yükseklik, kenarlık, odak halkası ve hata durumu her yerde birebir aynı görünsün).
 *
 * Notlar:
 * - `dark:[color-scheme:dark]`: date/time/number gibi native kontrollerin tarayıcı-çizimli
 *   parçaları (takvim ikonu, sayı okları) koyu temada beyaz-üstüne-beyaz kalıyordu.
 * - `aria-invalid`: doğrulama hatasında kenarlık VE odak outline'ı kırmızıya döner (renk TEK
 *   sinyal değil — hata metni de gösterilir).
 * - ODAK HALKASI YOK (bilinçli): odak göstergesi `globals.css`'teki katmansız `:focus-visible`
 *   kuralıdır ve bileşen `outline-none`'ını zaten yener. Buraya bir `ring-*` eklemek göstergeyi
 *   ikizler ve ölçülen kontrastı düşürür (`ring-ring/40` = 1.85:1, eşik 3:1). Kırmızı odak
 *   `--ring` değişkenini ezerek elde edilir — halka eklenerek değil.
 */
export const controlBase = cn(
  'w-full rounded-md border border-border bg-background text-sm text-foreground shadow-sm',
  'transition-[color,box-shadow,border-color] placeholder:text-muted-foreground',
  'selection:bg-primary selection:text-primary-foreground dark:[color-scheme:dark]',
  'focus-visible:border-ring',
  'aria-[invalid=true]:border-destructive aria-[invalid=true]:[--ring:var(--destructive)]',
  'disabled:cursor-not-allowed disabled:bg-muted/40 disabled:opacity-60',
);

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(
        controlBase,
        'h-9 px-3 py-1',
        // Dosya seçici: native "Choose file" düğmesi tema dışıydı (beyaz kutu) → kenarlıksız,
        // tipografisi hizalı bir iç düğmeye çevrilir.
        'file:mr-3 file:h-7 file:cursor-pointer file:rounded-md file:border-0 file:bg-secondary',
        'file:px-2.5 file:text-xs file:font-medium file:text-secondary-foreground',
        // Sayı alanlarında rakamlar sabit genişlikte olsun (tablo/adet alanlarında zıplamasın).
        type === 'number' && 'tabular-nums',
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
    data-slot="textarea"
    className={cn(controlBase, 'min-h-16 resize-y px-3 py-2 leading-relaxed', className)}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-xs font-medium text-foreground/70', className)} {...props} />;
}

/** Native <select> için Input ile hizalı tek-kaynak stil (formlarda paylaşılır). */
export const selectClass = cn(controlBase, 'h-9 cursor-pointer px-3');

/**
 * Native <input type="checkbox"> tek-kaynak stili. `accent-primary` koyu temada açık bir
 * dolgu + beyaz tik üretip kontrastı düşürüyordu; `accent-*` yerine tema değişkeni kullanılır.
 * Odak göstergesi global `:focus-visible` outline'ıdır (bkz. `controlBase` notu) — burada
 * DÖRT bant üst üste biniyordu: zemin-renkli offset halkası + soluk halka + boşluk + outline.
 */
export const checkboxClass = cn(
  'size-4 shrink-0 cursor-pointer rounded border-border accent-[var(--color-primary)]',
  'dark:[color-scheme:dark]',
  'disabled:cursor-not-allowed disabled:opacity-50',
);
