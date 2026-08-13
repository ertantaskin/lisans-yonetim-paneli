'use client';
import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { Search, X } from 'lucide-react';
import { cn } from '../../lib/utils';

/** cmdk sarmalayıcı (shadcn deseni) — faceted filter + arama listelerinde kullanılır. */
export const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      'flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
      className,
    )}
    {...props}
  />
));
Command.displayName = 'Command';

/**
 * Açılır liste içi arama satırı — panel genelindeki `SearchInput` ile AYNI refleksler:
 * aynı boyutta büyüteç (`size-3.5`), doluyken sağda aynı stilde temizle (×) düğmesi ve
 * `Escape` ile temizleme. (Önceden bu kutu temizlenemiyordu; operatör metni elle silmek
 * zorundaydı ve iki arama kutusu birbirine benzemiyordu.)
 *
 * KONTROL: dışarıdan `value` verilirse kontrollü (ör. Combobox sonuç sayacını da sürer),
 * verilmezse bileşen kendi state'ini tutar — çağrı yerleri (faceted filtre) DEĞİŞMEDEN
 * eski davranışı sürdürür, üstelik temizle/Escape orada da çalışır.
 *
 * NOT: Radix'in Escape dinleyicisi capture aşamasında olduğundan popover'ın kapanmasını
 * buradan engelleyemeyiz; dolu kutuda popover'ı AÇIK tutmak isteyen çağrı yeri bunu
 * `PopoverContent onEscapeKeyDown` ile yapar (bkz. `combobox.tsx`).
 */
export const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, value, onValueChange, onKeyDown, ...props }, ref) => {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [internal, setInternal] = React.useState('');
  const isControlled = value !== undefined;
  const current = value ?? internal;

  const setSearch = (next: string) => {
    if (!isControlled) setInternal(next);
    onValueChange?.(next);
  };

  const setRefs = React.useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = node;
    },
    [ref],
  );

  return (
    <div
      className="flex items-center gap-2 border-b border-border bg-muted/40 px-2.5"
      cmdk-input-wrapper=""
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <CommandPrimitive.Input
        ref={setRefs}
        value={current}
        onValueChange={setSearch}
        // Escape BURADA ele alınmaz: bu kutu her zaman bir katmanın (popover/dialog)
        // içinde yaşar ve orada Escape'in anlamı "katmanı kapat"tır. Temizlemek için
        // sağdaki (×) düğmesi var; katman kapanınca arama zaten sıfırlanır.
        onKeyDown={onKeyDown}
        className={cn(
          'h-9 min-w-0 flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50',
          className,
        )}
        {...props}
      />
      {current !== '' && (
        <button
          type="button"
          onClick={() => {
            setSearch('');
            inputRef.current?.focus();
          }}
          aria-label="Aramayı temizle"
          className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
});
CommandInput.displayName = 'CommandInput';

export const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn('max-h-72 overflow-y-auto overflow-x-hidden p-1', className)}
    {...props}
  />
));
CommandList.displayName = 'CommandList';

export const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(({ className, ...props }, ref) => (
  // `break-words`: boş durum metni arama terimini içerebiliyor (uzun terim taşmasın).
  <CommandPrimitive.Empty
    ref={ref}
    className={cn('break-words px-3 py-6 text-center text-sm text-muted-foreground', className)}
    {...props}
  />
));
CommandEmpty.displayName = 'CommandEmpty';

export const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      'overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground',
      className,
    )}
    {...props}
  />
));
CommandGroup.displayName = 'CommandGroup';

export const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
      'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
      className,
    )}
    {...props}
  />
));
CommandItem.displayName = 'CommandItem';

export const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator ref={ref} className={cn('-mx-1 h-px bg-border', className)} {...props} />
));
CommandSeparator.displayName = 'CommandSeparator';
