'use client';
import * as React from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn, includesTr } from '../../lib/utils';
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
 * Bir satırın aranabilir metin parçaları: etiket + ipucu + ek anahtar kelimeler.
 *
 * `value` (UUID / bileşik id) BİLEREK dışarıda: ham id'de geçen rakam parçaları ("3")
 * neredeyse her satırı eşleştirip aramayı işe yaramaz hâle getiriyordu. Gerçekten id ile
 * arama gereken çağrı yerleri (ör. mağaza ürün id'si) onu zaten `keywords` ile geçiriyor.
 *
 * cmdk'ya verilen `keywords` ile "N sonuç" sayacı AYNI diziden türetilir → gösterilen
 * sayı listedeki satır sayısıyla asla çelişmez.
 */
function itemTerms(item: ComboboxItem): string[] {
  return [item.label, item.hint, ...(item.keywords ?? [])].filter(
    (term): term is string => typeof term === 'string' && term.length > 0,
  );
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
  const [search, setSearch] = React.useState('');
  const query = search.trim();

  const selected = items.find((i) => i.value === current);

  /**
   * Filtre sonrası eşleşme sayısı — cmdk'nın `filter`'ıyla BİREBİR aynı yüklem.
   * `allowClear` satırı da GERÇEKTEN render edilen bir seçenektir ve aynı filtreden geçer;
   * sayıma katılmazsa şerit "2 sonuç" derken listede 3 satır görünür (duyuru da yanlış olur).
   */
  const matchCount = React.useMemo(() => {
    const hits = query
      ? items.filter((i) => includesTr(itemTerms(i).join(' '), query)).length
      : items.length;
    const clearHit = allowClear && (!query || includesTr(clearLabel, query)) ? 1 : 0;
    return hits + clearHit;
  }, [items, query, allowClear, clearLabel]);

  const setOpenState = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch(''); // kapanışta sıfırla — yeniden açılışta bayat filtre kalmasın
  };

  const choose = (next: string) => {
    if (!isControlled) setInternal(next);
    onValueChange?.(next);
    setOpenState(false);
  };

  return (
    <>
      {name && <input type="hidden" name={name} value={current} />}
      <Popover open={open} onOpenChange={setOpenState}>
        <PopoverTrigger asChild>
          <button
            type="button"
            id={id}
            role="combobox"
            aria-expanded={open}
            // NOT: `aria-autocomplete` BURAYA konmaz — bu tetikleyici düz bir <button>,
            // metin kabul etmez. Gerçek typeahead popover içindeki cmdk input'udur ve cmdk
            // kendi `role="combobox" aria-autocomplete="list" aria-controls"`unu zaten basar;
            // burada da ilan etmek iç içe iki combobox + yanlış "yazılabilir" sinyali üretirdi.
            // (`aria-controls`/`aria-haspopup`ı Radix'in PopoverTrigger'ı açıkken gerçek
            // içerik id'siyle kendisi basar; uydurma id üretmiyoruz.)
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
        {/* Overlay tetikleyici genişliğinde açılır; DAR tetikleyicide (ör. tablo faceti)
            liste ezilmesin diye alt sınır, geniş ekranda satır uzamasın diye üst sınır var. */}
        <PopoverContent
          align="start"
          onEscapeKeyDown={(event) => {
            // Dolu arama kutusunda Escape ÖNCE aramayı temizler, popover açık kalır;
            // boş kutuda Radix'in kendi davranışı (kapat) sürer. Radix Escape'i capture
            // aşamasında dinlediği için engelleme BURADA olmalı.
            //
            // Temizlemeyi de BURADA yapıyoruz, CommandInput'un kendi onKeyDown'ına
            // GÜVENMİYORUZ: o yalnız odak INPUT'tayken çalışır. Odak "temizle (×)"
            // düğmesindeyken (Tab ile ulaşılabilir) arama hiç boşalmaz ve bu guard her
            // Escape'i yutardı → popover yalnız dışarı tıklamayla kapanırdı.
            if (search !== '') {
              event.preventDefault();
              setSearch('');
            }
          }}
          className="w-[var(--radix-popover-trigger-width)] min-w-[16rem] max-w-[min(28rem,90vw)] p-0"
        >
          <Command
            label={ariaLabel ?? searchPlaceholder}
            filter={(_value, term, keywords) =>
              // Türkçe-duyarlı eşleşme: düz toLowerCase "IŞIK"ı "ışık" ile eşleştirmiyor,
              // "İ"yi bozuyordu → operatör sessizce boş liste görüyordu (bkz. lib/utils).
              includesTr((keywords ?? []).join(' '), term) ? 1 : 0
            }
          >
            <CommandInput placeholder={searchPlaceholder} value={search} onValueChange={setSearch} />
            <CommandList>
              <CommandEmpty>
                {query
                  ? `“${query.length > 32 ? `${query.slice(0, 32)}…` : query}” için sonuç yok`
                  : emptyText}
              </CommandEmpty>
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
                    keywords={itemTerms(item)}
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
            {/* Canlı bölge KOŞULSUZ monte: sonradan eklenen aria-live duyurulmaz. */}
            <span className="sr-only" aria-live="polite">
              {query ? `${matchCount} sonuç` : ''}
            </span>
            {query && matchCount > 1 && (
              // Görsel sayaç; duyuru yukarıdaki canlı bölgede → burada çift okunmasın.
              <div
                aria-hidden
                className="border-t border-border px-2.5 py-1.5 text-[11px] text-muted-foreground"
              >
                {matchCount} sonuç
              </div>
            )}
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}
