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
        'inline-flex h-9 w-full items-center gap-1 overflow-x-auto rounded-lg border border-border bg-muted/40 p-1 sm:w-auto',
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
