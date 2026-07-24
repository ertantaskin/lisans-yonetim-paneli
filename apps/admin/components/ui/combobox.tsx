'use client';
import * as React from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command';

export interface ComboboxItem {
  /** Form'a gönderilecek değer (id). Benzersiz olmalı. */
  value: string;
  /** Kullanıcıya görünen ad (ör. ürün adı). */
  label: string;
  /** İkincil satır (ör. SKU, tür) — sağda soluk gösterilir + aramaya dahildir. */
  hint?: string;
  /** Ek arama terimleri (ör. SKU, alternatif ad) — etikette görünmez ama eşleşir. */
  keywords?: string[];
}

/**
 * Combobox — ARANABİLİR tek-seçim (typeahead). Uzun listeleri (ör. tüm ürünler/siteler)
 * kaydırmak yerine yazarak filtrelemek için native `<select>` yerine kullanılır. Sunucu
 * eylemleriyle (`<form action={...}>`) uyumludur: seçilen değeri gizli bir `<input name>`
 * ile taşır. Ürünler SKU **ve** ada göre aranır (operatör hangisini bilirse).
 *
 * Kontrolsüz: `defaultValue`. Kontrollü: `value` + `onValueChange` (ör. import formunda
 * seçilen ürünün şema ipucunu sürmek için).
 */
export function Combobox({
  name,
  items,
  value,
  defaultValue,
  onValueChange,
  placeholder = 'Seçin…',
  searchPlaceholder = 'Ara…',
  emptyText = 'Sonuç yok',
  allowClear = false,
  clearLabel = '— temizle —',
  id,
  required,
  disabled,
  className,
  ariaLabel,
}: {
  /** Gizli input adı — sunucu eylemi bu alanı okur. */
  name?: string;
  items: ComboboxItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Seçimi boşaltma satırı göster (ör. "— tüm ürünler —"). */
  allowClear?: boolean;
  clearLabel?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const isControlled = value !== undefined;
  const [internal, setInternal] = React.useState(defaultValue ?? '');
  const current = isControlled ? value : internal;
  const [open, setOpen] = React.useState(false);

  const selected = items.find((i) => i.value === current);

  const choose = (next: string) => {
    if (!isControlled) setInternal(next);
    onValueChange?.(next);
    setOpen(false);
  };

  return (
    <>
      {name && <input type="hidden" name={name} value={current} />}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-label={ariaLabel}
            aria-required={required}
            disabled={disabled}
            className={cn(
              'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors',
              'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40',
              'disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-ring',
              className,
            )}
          >
            <span className={cn('truncate text-left', !selected && 'text-muted-foreground')}>
              {selected ? selected.label : placeholder}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden />
          </button>
        </PopoverTrigger>
        {/* Overlay, tetikleyici genişliğinde açılır (uzun liste + arama). */}
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
          <Command
            filter={(val, search, keywords) => {
              const q = search.trim().toLowerCase();
              if (!q) return 1;
              const hay = `${val} ${(keywords ?? []).join(' ')}`.toLowerCase();
              return hay.includes(q) ? 1 : 0;
            }}
          >
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>{emptyText}</CommandEmpty>
              <CommandGroup>
                {allowClear && (
                  <CommandItem
                    value="__clear__"
                    keywords={[clearLabel]}
                    onSelect={() => choose('')}
                    className="text-muted-foreground"
                  >
                    <Check
                      className={cn('size-4', current === '' ? 'opacity-100' : 'opacity-0')}
                      aria-hidden
                    />
                    <span className="flex-1 truncate">{clearLabel}</span>
                  </CommandItem>
                )}
                {items.map((item) => (
                  <CommandItem
                    key={item.value}
                    value={item.value}
                    keywords={[item.label, ...(item.hint ? [item.hint] : []), ...(item.keywords ?? [])]}
                    onSelect={() => choose(item.value)}
                  >
                    <Check
                      className={cn(
                        'size-4 shrink-0',
                        current === item.value ? 'opacity-100' : 'opacity-0',
                      )}
                      aria-hidden
                    />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.hint && (
                      <span className="shrink-0 text-xs text-muted-foreground">{item.hint}</span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}
