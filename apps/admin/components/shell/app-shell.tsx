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
  children,
}: {
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  if (pathname === '/login') return <>{children}</>;

  return (
    <>
      <SidebarProvider defaultOpen={defaultOpen}>
        <AppSidebar />
        <SidebarInset>
          <SiteHeader />
          <main className="min-w-0 flex-1 px-4 py-5 md:px-6 md:py-6">{children}</main>
        </SidebarInset>
      </SidebarProvider>
      <CommandPalette />
    </>
  );
}
