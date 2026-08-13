'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { NAV } from './nav';
import { NavUser } from './nav-user';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '../ui/sidebar';

/** Uygulama kenar menüsü — marka + gruplu bilgi mimarisi + kullanıcı (§17). */
export function AppSidebar({ user }: { user?: { name: string; email: string; role?: string } }) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  // Aktif öğe = pathname'e uyan EN UZUN href. Düz prefix eşleşmesi kullanılamaz:
  // /stock/import açıkken hem "Stok & Ürünler" (/stock) hem "Stok Girişi" aktif görünürdü.
  let activeHref = '';
  for (const section of NAV) {
    for (const item of section.items) {
      if (item.href === '#') continue;
      const hit = pathname === item.href || pathname.startsWith(item.href + '/');
      if (hit && item.href.length > activeHref.length) activeHref = item.href;
    }
  }
  const isActive = (href: string) => href !== '#' && href === activeHref;
  // ownerOnly öğeler: auth kapalıysa (user yok) VEYA owner ise görünür.
  const canSee = (item: { ownerOnly?: boolean }) => !item.ownerOnly || !user || user.role === 'owner';

  return (
    // variant="inset": sayfa zemini sidebar rengine döner, içerik yüzen bir karta oturur
    // (shadcnspace kabuğu). Kenar menü kenarlıksız ve zeminle aynı düzlemde kalır.
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="gap-2.5">
              <Link href="/">
                <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <KeyRound className="size-4.5" />
                </span>
                <span className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold">Lisans Paneli</span>
                  <span className="truncate text-[11px] text-sidebar-foreground/60">
                    Tedarik & Yönetim
                  </span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {NAV.map((section) => {
          const items = section.items.filter(canSee);
          if (items.length === 0) return null;
          return (
          <SidebarGroup key={section.title}>
            <SidebarGroupLabel>{section.title}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <SidebarMenuItem key={item.label}>
                      <SidebarMenuButton
                        asChild={!item.soon}
                        isActive={!item.soon && isActive(item.href)}
                        tooltip={item.label}
                        aria-disabled={item.soon}
                        className={item.soon ? 'cursor-default opacity-50' : undefined}
                      >
                        {item.soon ? (
                          <span>
                            <Icon />
                            <span>{item.label}</span>
                          </span>
                        ) : (
                          <Link
                            href={item.href}
                            // Mobilde menü bir sheet; tıklayınca KAPANMALI, yoksa gidilen
                            // sayfa örtülü kalıyor ve kullanıcı ayrıca kapatmak zorunda.
                            onClick={() => setOpenMobile(false)}
                            // Aktiflik yalnız renkle iletilmesin (WCAG 1.4.1) — yardımcı
                            // teknolojiye `aria-current` ile de bildirilir.
                            aria-current={isActive(item.href) ? 'page' : undefined}
                          >
                            <Icon />
                            <span>{item.label}</span>
                          </Link>
                        )}
                      </SidebarMenuButton>
                      {item.soon && <SidebarMenuBadge>yakında</SidebarMenuBadge>}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter>
        <NavUser user={user ?? { name: 'Operatör', email: 'oturum yok' }} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
