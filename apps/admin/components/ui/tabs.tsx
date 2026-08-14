'use client';
import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import {
  SEGMENTED_ITEM,
  SEGMENTED_ITEM_IDLE,
  SEGMENTED_LIST,
} from '../../lib/segmented';
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
        SEGMENTED_LIST,
        'w-full sm:w-auto',
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
        SEGMENTED_ITEM,
        SEGMENTED_ITEM_IDLE,
        // Odak halkası YOK (globals.css TEK KAYNAK outline). Buradaki eski istisna, TabsList
        // `overflow-x-auto` taşırken outline'ın kırpılmasına dayanıyordu; liste kaydırma yerine
        // SARMAYA geçince kırpan kap kalmadı ve halka kaldırıldı.
        // Aktif durum Radix data-özniteliğinden sürülür; renkler paylaşılan sabitle aynı.
        'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
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
