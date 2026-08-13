'use client';
import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '../../lib/utils';

/**
 * Sekme primitifi (Radix Tabs — bağımlılık zaten kurulu).
 *
 * NEDEN: ürün detayı gibi "aynı kaydın farklı yüzleri" olan ekranlarda yedi kartı üst üste
 * yığmak yerine dört sekmeye ayırmak, ekranı bir bakışta okunur kılar. Sekme içerikleri
 * SUNUCUDA render edilmiş çocuklar olabilir — bu dosya yalnız açılıp kapanmayı bilir.
 *
 * `TabsContent` varsayılan olarak seçili olmayan sekmeyi DOM'dan kaldırır: gizli sekmedeki
 * form alanları sekme sırasına girmez ve gereksiz istemci işi yapılmaz.
 */
export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        // KAYDIRMA DEĞİL, SARMA (quarantine-nav'da aynı kusur için doğrulanan desen):
        // `overflow-x-auto` yatay çubuğu SABİT 36px'lik barın İÇİNE çiziyordu (globals.css
        // `::-webkit-scrollbar { height: 9px }`) → sekme etiketlerinden ~10px çalıyordu.
        // Kaydırmayı gizlemek (`[scrollbar-width:none]`) çözüm değildi: görsel ipucu tamamen
        // kaybolur, operatör sağda sekme olduğunu anlayamazdı. Dar ekranda sekmeler alt satıra
        // sarar; `sm:w-auto` sayesinde geniş ekranda görünüm birebir aynı (tek satır) kalır.
        // `h-9` → `min-h-9`: 28px'lik tetik 26px'lik içerik kutusuna sığmıyordu (kalıcı 1px
        // dikey taşma + her genişlikte beliren dikey çubuk artefaktı) — ancak böyle kapanır.
        'inline-flex min-h-9 w-full flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/40 p-1 sm:w-auto',
        className,
      )}
      {...props}
    />
  );
});

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium text-muted-foreground transition-colors',
        'hover:text-foreground',
        // globals.css'teki "bileşen kendi halkasını eklemez" kuralına İSTİSNA.
        // GEREKÇE ARTIK GEÇERSİZ: bu istisna TabsList'in `overflow-x-auto` taşıması yüzünden
        // konmuştu (overflow-y de `auto`ya hesaplanıyor → elemanın 4px DIŞINA çizilen global
        // outline üst/altta 1px kırpılıyordu). TabsList artık kaydırmıyor, SARIYOR (yukarı bak)
        // → kap kırpmıyor, global outline eksiksiz görünüyor. Halkanın kaldırılması odak
        // göstergesi sözleşmesine (globals.css TEK KAYNAK) dokunduğu için AYRI bir değişiklik
        // olarak ele alınmalı; burada davranış bilinçli olarak korundu.
        // Tam opaklık (6.54:1 açık / 4.18:1 koyu) — soluk /60 varyantı 3:1 eşiğinin altındaydı.
        'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
});

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn('mt-4 focus-visible:outline-none', className)}
      {...props}
    />
  );
});
