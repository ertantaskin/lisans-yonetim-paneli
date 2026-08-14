/**
 * Segment çubuğu (bir kümeden TEK seçim) görünümünün TEK KAYNAĞI.
 *
 * Panelde aynı anlamı taşıyan çubuk DÖRT farklı biçimde çiziliyordu:
 *   · `ui/tabs.tsx`            — kap `bg-muted/40` + aktif KABARTMA (`bg-background` + `shadow-sm`)
 *   · `support-table.tsx`      — kap `bg-card` + aktif DOLU `bg-primary`
 *   · `claims/quarantine-nav`  — aktifte fazladan `ring-1 ring-border`, öğe dolgusu `px-3.5 py-2`
 *   · `stock/import` parti modu — kap `rounded-md p-0.5`, öğe `rounded-[0.3rem] text-xs`
 * Operatör için hepsi aynı işi yapar; farklı görünmeleri tasarım sistemi hatasıydı.
 *
 * Kanonik dil `ui/tabs.tsx`'ten alındı (referansın sekme çubuğu ölçüsü): kap gri, seçili öğe
 * yüzeye ÇIKAR (`bg-background` + `shadow-sm`), seçili olmayan `muted`.
 *
 * KURAL: buraya odak halkası (`ring-*`, `focus-visible:ring`) EKLENMEZ — odak göstergesi tek
 * kaynak `globals.css` içindeki katmansız `:focus-visible { outline }` kuralıdır.
 * Yeni renk hue'su da eklenmez; seçim ayrımı yüzey + gölge ile yapılır.
 */

/** Segment çubuğunun KABI. Genişlik davranışı çağrı yerine bırakılır (`w-full`, `sm:w-auto`…). */
export const SEGMENTED_LIST =
  'inline-flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/40 p-1';

/** Tek bir segment öğesi — seçili/seçili değil ayrımı AYRI sabitlerde. */
export const SEGMENTED_ITEM =
  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-colors [&_svg]:size-4 [&_svg]:shrink-0 disabled:pointer-events-none disabled:opacity-50';

/** Seçili öğe: gri kaptan yüzeye çıkar. */
export const SEGMENTED_ITEM_ACTIVE = 'bg-background text-foreground shadow-sm';

/** Seçili olmayan öğe. */
export const SEGMENTED_ITEM_IDLE = 'text-muted-foreground hover:text-foreground';

/** Kısayol: duruma göre öğe sınıflarını birleştirir (cn ile sarmalanmalı). */
export const segmentedItem = (active: boolean) =>
  `${SEGMENTED_ITEM} ${active ? SEGMENTED_ITEM_ACTIVE : SEGMENTED_ITEM_IDLE}`;
