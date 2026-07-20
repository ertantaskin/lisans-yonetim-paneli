'use client';
import * as React from 'react';
import { usePathname } from 'next/navigation';
import { SidebarInset, SidebarProvider } from '../ui/sidebar';
import { AppSidebar } from './app-sidebar';
import { SiteHeader } from './site-header';
import { CommandPalette } from './command-palette';

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
    <>
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
          <main className="min-w-0 flex-1 px-4 py-5 md:px-6 md:py-6">{children}</main>
        </SidebarInset>
      </SidebarProvider>
      <CommandPalette />
    </>
  );
}
