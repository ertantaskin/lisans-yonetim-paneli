'use client';
import * as React from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { controlBase } from './input';

/**
 * SearchInput — panel genelinde TEK arama kutusu deseni (§17).
 *
 * Neden ayrı bileşen: düz `<Input placeholder="Ara…">` kutusu ne olduğunu anlatmıyordu ve
 * yazılan metni temizlemek için metni elle silmek gerekiyordu. Bu sürüm:
 *  - solda büyüteç ikonu (ne olduğu bir bakışta belli),
 *  - doluyken sağda temizle (×) düğmesi (klavye ile de erişilebilir),
 *  - `Escape` ile temizleme,
 *  - `type="search"` (tarayıcının kendi X'i `appearance-none` ile kapatılır — çift X olmasın).
 *
 * Kontrollü kullanılır (`value` + `onValueChange`) — hem TanStack tablo filtresi hem URL
 * parametreli sunucu aramaları aynı bileşeni paylaşır.
 */
export function SearchInput({
  value,
  onValueChange,
  placeholder = 'Ara…',
  ariaLabel,
  className,
  inputClassName,
  autoFocus,
  name,
  id,
}: {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  /** Sarmalayıcı genişliği (ör. 'w-full sm:w-64'). */
  className?: string;
  inputClassName?: string;
  autoFocus?: boolean;
  /** Verilirse native form gönderiminde de taşınır (sunucu-taraflı arama formları). */
  name?: string;
  id?: string;
}) {
  const ref = React.useRef<HTMLInputElement>(null);

  return (
    <div className={cn('relative', className)}>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        ref={ref}
        id={id}
        name={name}
        type="search"
        autoFocus={autoFocus}
        aria-label={ariaLabel ?? placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            onValueChange('');
          }
        }}
        className={cn(
          controlBase,
          'h-8 pl-8 pr-8',
          // Tarayıcının kendi temizle/arama süslerini kapat (bizimki tutarlı ve temalı).
          '[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none',
          inputClassName,
        )}
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onValueChange('');
            ref.current?.focus();
          }}
          aria-label="Aramayı temizle"
          className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}
