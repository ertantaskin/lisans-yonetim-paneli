'use client';
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { PanelLeft } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useIsMobile } from '../../lib/hooks/use-mobile';
import { Button } from './button';
import { Separator } from './separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

/*
 * shadcn "sidebar" block'unun sadık, sadeleştirilmiş uyarlaması (satnaing/shadcn-admin
 * referansı). Provider + context; cookie ile açık/kapalı kalıcılığı; Ctrl/⌘+B kısayolu;
 * masaüstünde icon-collapse rayı; mobilde sheet. Tümü mevcut bağımlılıklarla (yeni dep yok).
 */

const SIDEBAR_COOKIE_NAME = 'sidebar_state';
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_WIDTH = '16rem';
const SIDEBAR_WIDTH_MOBILE = '18rem';
const SIDEBAR_WIDTH_ICON = '3rem';
const SIDEBAR_KEYBOARD_SHORTCUT = 'b';

type SidebarContextValue = {
  state: 'expanded' | 'collapsed';
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error('useSidebar, SidebarProvider içinde kullanılmalı.');
  return ctx;
}

export function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);
  const [_open, _setOpen] = React.useState(defaultOpen);
  const open = openProp ?? _open;

  const setOpen = React.useCallback(
    (value: boolean | ((v: boolean) => boolean)) => {
      const next = typeof value === 'function' ? value(open) : value;
      if (setOpenProp) setOpenProp(next);
      else _setOpen(next);
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${next}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
    },
    [setOpenProp, open],
  );

  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((o) => !o) : setOpen((o) => !o);
  }, [isMobile, setOpen]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === SIDEBAR_KEYBOARD_SHORTCUT && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);

  const state = open ? 'expanded' : 'collapsed';

  const value = React.useMemo<SidebarContextValue>(
    () => ({ state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar }),
    [state, open, setOpen, isMobile, openMobile, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        style={
          {
            '--sidebar-width': SIDEBAR_WIDTH,
            '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
            ...style,
          } as React.CSSProperties
        }
        // `overflow-x-clip` emniyet kemeri: SidebarInset'teki `min-w-0`dan sonra da bir torun
        // sabit genişlikle taşarsa, taşma en fazla KIRPILIR — viewport'a kaydırma olarak YAYILMAZ.
        // `overflow-hidden` DEĞİL, çünkü o bir kaydırma kabı oluşturur ve sticky SiteHeader'ı
        // bozardı; `clip` kaydırma kabı yaratmaz. Bu kap transform/filter/contain taşımadığı için
        // içerme bloğu da kurmaz → sidebar'ın `position:fixed` katmanı kırpılmaz.
        // `has-data-[variant=inset]:bg-sidebar`: inset düzeninde SAYFA zemini sidebar rengine
        // döner; içerik `SidebarInset` içinde yüzen beyaz bir karta oturur (shadcnspace deseni —
        // referansta ölçüldü: wrapper `has-data-[variant=inset]:bg-sidebar`, main `m-2 rounded-xl`).
        // `has-data-[variant=inset]:gap-1`: kenar menü ile yüzen içerik kartı arasında 4px oluk
        // (referansta ölçüldü). Oluksuz halde kartın 1px outline'ı menünün kenarına yapışıyor ve
        // sınır "ezik" görünüyordu. Mobilde menü `display:none` olduğundan gap etkisizdir.
        className={cn(
          'group/sidebar-wrapper flex min-h-svh w-full overflow-x-clip has-data-[variant=inset]:bg-sidebar has-data-[variant=inset]:gap-1',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function Sidebar({
  side = 'left',
  variant = 'sidebar',
  collapsible = 'icon',
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  side?: 'left' | 'right';
  variant?: 'sidebar' | 'floating' | 'inset';
  collapsible?: 'offcanvas' | 'icon' | 'none';
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();

  if (collapsible === 'none') {
    return (
      <div
        className={cn('flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground', className)}
        {...props}
      >
        {children}
      </div>
    );
  }

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
        <SheetContent
          side={side}
          hideClose
          className="w-(--sidebar-width) bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden"
          style={{ '--sidebar-width': SIDEBAR_WIDTH_MOBILE } as React.CSSProperties}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Kenar menü</SheetTitle>
            <SheetDescription>Panel gezinme menüsü</SheetDescription>
          </SheetHeader>
          <div className="flex h-full w-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      className="group peer hidden text-sidebar-foreground md:block"
      data-state={state}
      data-collapsible={state === 'collapsed' ? collapsible : ''}
      data-variant={variant}
      data-side={side}
    >
      {/* Genişlik boşluğu — içerik itilir */}
      <div
        className={cn(
          'relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear',
          'group-data-[collapsible=offcanvas]:w-0',
          'group-data-[collapsible=icon]:w-(--sidebar-width-icon)',
        )}
      />
      <div
        className={cn(
          'fixed inset-y-0 z-30 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear md:flex',
          side === 'left'
            ? 'left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]'
            : 'right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]',
          'group-data-[collapsible=icon]:w-(--sidebar-width-icon)',
          className,
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          className={cn(
            'flex h-full w-full flex-col bg-sidebar border-sidebar-border',
            // inset'te kenarlık YOK: sayfa zemini zaten sidebar rengi ve içerik kartı 8px
            // boşlukla ayrılıyor — bir de çizgi çekmek sahte bir sınır üretirdi.
            variant === 'inset'
              ? ''
              : 'group-data-[side=left]:border-r group-data-[side=right]:border-l',
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Kenar menüyü aç/kapat"
      className={cn('size-8', className)}
      onClick={(e) => {
        onClick?.(e);
        toggleSidebar();
      }}
      {...props}
    >
      <PanelLeft />
    </Button>
  );
}

export function SidebarRail({ className, ...props }: React.ComponentProps<'button'>) {
  const { toggleSidebar } = useSidebar();
  return (
    <button
      aria-label="Kenar menüyü aç/kapat"
      tabIndex={-1}
      onClick={toggleSidebar}
      title="Aç/Kapat"
      className={cn(
        'absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 cursor-w-resize transition-all ease-linear hover:after:bg-sidebar-border sm:flex',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-px',
        'group-data-[side=left]:-right-4 group-data-[side=right]:left-0',
        className,
      )}
      {...props}
    />
  );
}

// <div> (eskiden <main>): app-shell bunun İÇİNDE asıl `<main id="main-content">` landmark'ını
// render ediyor → iç içe iki `main` oluşuyordu ve ekran okuyucuda iki "ana bölge" görünüyordu.
// Landmark'ı içerideki gerçek içerik elemanına bırakmak semantik olarak da doğru: üst bar
// (SiteHeader) bu kabın içinde ve ana içeriğin parçası değil.
export function SidebarInset({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      // `min-w-0` ŞART — panelin "sayfa gövdesi asla yatay kaymaz" sözleşmesinin kilit halkası.
      // SidebarProvider (yukarıda) `flex w-full` bir SATIR; bu eleman onun flex çocuğu, yani
      // varsayılan `min-width:auto` ile otomatik minimumu İÇERİĞİNİN min-content genişliği olur
      // → geniş bir torun (tablo sarmalayıcısı, sarmayan araç çubuğu) kabı viewport'un ötesine
      // iter ve taşma SAYFAYA yayılır. app-shell'deki `main` zaten `min-w-0` taşıyor ama koruma
      // bir seviye DERİNDE kaldığı için zincir burada kopuyordu (ölçüldü: 810px'te scrollWidth 856).
      className={cn(
        'relative flex min-h-svh min-w-0 flex-1 flex-col bg-background',
        // ── inset (yüzen kart) düzeni ────────────────────────────────────────────
        // `peer-*`: kardeş <Sidebar> kökü `peer` sınıfını taşır, data-variant oradan okunur.
        // Yalnız md+: mobilde sidebar tamamen gizli, kenar boşluğu ekran genişliğini yer.
        // min-h: m-2 dikeyde 16px (=1rem) yer kaplar → çıkarılmazsa her sayfada 16px'lik
        // sahte dikey kaydırma çubuğu oluşur.
        'md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0',
        'md:peer-data-[variant=inset]:min-h-[calc(100svh-1rem)]',
        'md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm',
        'md:peer-data-[variant=inset]:outline md:peer-data-[variant=inset]:outline-border',
        className,
      )}
      {...props}
    />
  );
}

export function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  // YATAY dolgu SidebarGroup ile AYNI olmalı (8px): marka satırı, menü öğeleri ve kullanıcı
  // satırı tek dikey eksende hizalanır. `p-3` denendi ve KIRDI — ölçüldü: açık menüde marka/
  // kullanıcı x=12 iken menü öğeleri x=8 (4px kayma); 48px ikon rayında ise düğme merkezi 28
  // (ray merkezi 24) ve kullanıcı avatarı x=47'ye taşıp kırpılıyordu. Dikeyde 12px serbest.
  return (
    <div data-sidebar="header" className={cn('flex flex-col gap-2 px-2 py-3', className)} {...props} />
  );
}

export function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  // Yatay dolgu SidebarHeader/SidebarGroup ile aynı (8px) — gerekçe SidebarHeader'da.
  return (
    <div data-sidebar="footer" className={cn('flex flex-col gap-2 px-2 py-3', className)} {...props} />
  );
}

export function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-sidebar="content"
      className={cn(
        // Dikey kaydırma İKİ modda da açık. Eskiden ikon modunda kapatılıyordu; 25 menü öğesi
        // ikon modunda ~1170px yer kapladığı için kısa ekranlarda alttaki öğeler kırpılıyor VE
        // kaydırılamıyordu (Şablonlar/Sürümler/Dağıtımlar/Ayarlar/Rehber erişilemezdi).
        'no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden',
        className,
      )}
      {...props}
    />
  );
}

export function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-sidebar="group" className={cn('relative flex w-full min-w-0 flex-col p-2', className)} {...props} />
  );
}

export function SidebarGroupLabel({
  className,
  asChild,
  ...props
}: React.ComponentProps<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'div';
  return (
    <Comp
      data-sidebar="group-label"
      className={cn(
        // shadcnspace referansı: `px-3 text-xs uppercase font-semibold text-muted-foreground`
        // (ölçüldü: 12px/600/uppercase). Eskiden 11px + `tracking-wide` idi.
        'flex h-8 shrink-0 items-center rounded-md px-3 text-xs font-semibold uppercase text-muted-foreground transition-[margin,opacity] duration-200 ease-linear',
        'group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

export function SidebarGroupContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-sidebar="group-content" className={cn('w-full text-sm', className)} {...props} />;
}

export function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return <ul data-sidebar="menu" className={cn('flex w-full min-w-0 flex-col gap-1', className)} {...props} />;
}

export function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return <li data-sidebar="menu-item" className={cn('group/menu-item relative', className)} {...props} />;
}

const sidebarMenuButtonVariants = cva(
  // shadcnspace deseni (referanstan ölçüldü):
  //   öğe   → `flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium`
  //   hover → `hover:bg-primary/5 hover:text-primary` + `hover:translate-x-1` (kayma)
  //   aktif → `bg-primary text-background` (DOLU pill; eskiden soluk `bg-sidebar-accent` idi)
  // Kayma yalnız genişken: ikon modunda 40px kutuda 4px kayma ikonu kırpardı.
  // `motion-reduce:` — hareket azaltma tercihinde kayma yok (WCAG 2.3.3).
  'peer/menu-button flex w-full items-center gap-3 overflow-hidden rounded-md px-3 py-2 text-left text-sm font-medium outline-none transition-[width,height,padding,transform,background-color,color] duration-200 ease-in-out disabled:pointer-events-none disabled:opacity-50 group-has-[[data-sidebar=menu-action]]/menu-item:pr-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 hover:translate-x-1 group-data-[collapsible=icon]:hover:translate-x-0 motion-reduce:hover:translate-x-0 data-[active=true]:bg-primary data-[active=true]:text-primary-foreground data-[active=true]:font-medium data-[active=true]:hover:bg-primary data-[active=true]:hover:text-primary-foreground group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:p-2 group-data-[collapsible=icon]:hover:translate-x-0 group-data-[collapsible=icon]:[&>span:last-child]:hidden [&>span:last-child]:truncate [&>svg]:size-4.5 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        // Hover TEK KAYNAK burada: cva'da varyant sınıfları tabandan SONRA gelir ve
        // tailwind-merge'de son yazan kazanır → tabana da hover yazılsaydı bu ezerdi.
        default: 'hover:bg-primary/5 hover:text-primary',
        outline:
          'bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-primary/5 hover:text-primary',
      },
      size: {
        default: 'h-9',
        sm: 'h-8 text-xs',
        lg: 'h-11 group-data-[collapsible=icon]:!p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> & {
    asChild?: boolean;
    isActive?: boolean;
    tooltip?: string;
  } & VariantProps<typeof sidebarMenuButtonVariants>
>(({ asChild, isActive, tooltip, variant, size, className, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  const { isMobile, state } = useSidebar();

  const button = (
    <Comp
      ref={ref}
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  );

  if (!tooltip) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" align="center" hidden={state !== 'collapsed' || isMobile}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
});
SidebarMenuButton.displayName = 'SidebarMenuButton';

export function SidebarMenuBadge({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-sidebar="menu-badge"
      className={cn(
        'pointer-events-none absolute right-1.5 flex h-5 min-w-5 select-none items-center justify-center rounded-md px-1 text-[10px] font-medium tabular-nums text-sidebar-foreground/70',
        'peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground',
        'top-1/2 -translate-y-1/2 group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  );
}

export function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator data-sidebar="separator" className={cn('mx-2 w-auto bg-sidebar-border', className)} {...props} />
  );
}
