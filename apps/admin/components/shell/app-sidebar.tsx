'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { KeyRound, LayoutDashboard } from 'lucide-react';
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
} from '../ui/sidebar';

/** Uygulama kenar menüsü — marka + gruplu bilgi mimarisi + kullanıcı (§17). */
export function AppSidebar() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href !== '#' && (pathname === href || pathname.startsWith(href + '/'));

  return (
    <Sidebar collapsible="icon">
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
        {NAV.map((section) => (
          <SidebarGroup key={section.title}>
            <SidebarGroupLabel>{section.title}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => {
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
                          <Link href={item.href}>
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
        ))}
      </SidebarContent>

      <SidebarFooter>
        <NavUser
          user={{ name: 'Operatör', email: 'admin@lisanspaneli', icon: LayoutDashboard }}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
