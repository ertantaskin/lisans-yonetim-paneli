'use client';
import * as React from 'react';
import { usePathname } from 'next/navigation';
import { SidebarInset, SidebarProvider } from '../ui/sidebar';
import { AppSidebar } from './app-sidebar';
import { SiteHeader } from './site-header';
import { CommandPalette } from './command-palette';
import { AnnouncerProvider } from '../a11y/announcer';

/**
 * Uygulama kabuğu. /login yolunda kabuğu (sidebar/header) GİZLER → giriş sayfası
 * tam ekran, çıplak render olur. Diğer tüm yollarda shadcn sidebar kabuğu.
 */
export function AppShell({
  defaultOpen,
  user,
  authOff,
  children,
}: {
  defaultOpen: boolean;
  user?: { name: string; email: string; role?: string };
  authOff?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  if (pathname === '/login') return <>{children}</>;

  return (
    <AnnouncerProvider>
      {/* İçeriğe atla (WCAG 2.4.1) — klavye/okuyucu ilk odakta ~20 sidebar linkini
          atlayıp ana içeriğe geçer. Normalde gizli, odaklanınca görünür. */}
      <a
        href="#main-content"
        className="sr-only rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground shadow-lg outline-none ring-ring focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:ring-2"
      >
        İçeriğe atla
      </a>
      <SidebarProvider defaultOpen={defaultOpen}>
        <AppSidebar user={user} />
        <SidebarInset>
          {authOff && (
            <div className="flex items-center justify-center gap-2 bg-[color-mix(in_oklch,var(--warning)_16%,transparent)] px-4 py-1.5 text-center text-xs font-medium text-warning">
              ⚠ Kimlik doğrulama KAPALI — panel herkese açık. Etkinleştirmek için SESSION_SECRET +
              ADMIN_SEED_* ayarlayın.
            </div>
          )}
          <SiteHeader />
          {/* tabIndex=-1: atla-linki hedefi programatik odaklanabilir olmalı. */}
          <main
            id="main-content"
            tabIndex={-1}
            className="min-w-0 flex-1 px-4 py-5 outline-none md:px-6 md:py-6"
          >
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
      <CommandPalette />
    </AnnouncerProvider>
  );
}
