import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Toaster } from 'sonner';
import { ThemeProvider } from '../components/theme';
import { TooltipProvider } from '../components/ui/tooltip';
import { SidebarProvider, SidebarInset } from '../components/ui/sidebar';
import { AppSidebar } from '../components/shell/app-sidebar';
import { SiteHeader } from '../components/shell/site-header';
import { CommandPalette } from '../components/shell/command-palette';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jbmono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Lisans Paneli — Tedarik & Yönetim',
  description: 'Merkezi lisans stok, tedarik ve teslimat paneli',
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Sidebar açık/kapalı durumu cookie'den (sunucu → hydration flash yok).
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get('sidebar_state')?.value !== 'false';

  // Arayüz Türkçe-öncelikli (§17).
  return (
    <html lang="tr" suppressHydrationWarning className={`${inter.variable} ${mono.variable}`}>
      <body>
        <ThemeProvider>
          <TooltipProvider delayDuration={200}>
            <SidebarProvider defaultOpen={defaultOpen}>
              <AppSidebar />
              <SidebarInset>
                <SiteHeader />
                <main className="min-w-0 flex-1 px-4 py-5 md:px-6 md:py-6">{children}</main>
              </SidebarInset>
            </SidebarProvider>
            <CommandPalette />
            <Toaster
              position="bottom-right"
              toastOptions={{
                classNames: {
                  toast: 'rounded-md border border-border bg-card text-foreground shadow-lg',
                },
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
