'use client';
import * as React from 'react';
import { usePathname } from 'next/navigation';
import { SidebarInset, SidebarProvider } from '../ui/sidebar';
import { AppSidebar } from './app-sidebar';
import { SiteHeader } from './site-header';
import { CommandPalette } from './command-palette';
import { AnnouncerProvider } from '../a11y/announcer';
import { LiveProvider } from '../live/live-provider';
import { LiveAlerts } from '../live/live-alerts';

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
      {/* Canlı akış TEK sağlayıcıda: üst bardaki bildirim çanı ve genel bakış ekranı aynı
          poll'u paylaşır (ekran başına ayrı istek yok). /login'de mount EDİLMEZ (yukarıda
          erken dönüş) → giriş sayfası hiçbir yetkili uca dokunmaz. */}
      <LiveProvider>
      {/* Dikkat katmanı: sekme başlığı sayacı + yeni kayıt toast'ı. Görsel çıktısı yok,
          kabukta bir kez mount edilir → hangi ekranda olursak olalım yeni sipariş duyurulur. */}
      <LiveAlerts />
      {/* İçeriğe atla (WCAG 2.4.1) — klavye/okuyucu ilk odakta ~20 sidebar linkini
          atlayıp ana içeriğe geçer. Normalde gizli, odaklanınca görünür. */}
      <a
        href="#main-content"
        // Odak halkası YOK: gösterge tek kaynak globals.css `:focus-visible { outline }`.
        // (Eskiden `focus:ring-2` ile ikizleniyordu — ölçülen halka kontrastı eşik altı.)
        // Yarıçap/gölge yeni dile alındı: rounded-lg + shadow-xs.
        className="sr-only rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-foreground shadow-xs focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
      >
        İçeriğe atla
      </a>
      <SidebarProvider defaultOpen={defaultOpen}>
        <AppSidebar user={user} />
        <SidebarInset>
          {authOff && (
            // İçerik kartının EN ÜST öğesi bu olduğunda üst köşeleri yuvarlatan taraf odur
            // (aksi halde kare köşe, yuvarlak kartın dışına taşar).
            <div className="flex items-center justify-center gap-2 bg-[color-mix(in_oklch,var(--warning-vivid)_16%,transparent)] px-4 py-1.5 text-center text-xs font-medium text-warning md:rounded-t-xl">
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
      </LiveProvider>
    </AnnouncerProvider>
  );
}
