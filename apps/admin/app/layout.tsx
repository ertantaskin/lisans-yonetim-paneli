import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Toaster } from 'sonner';
import { ThemeProvider } from '../components/theme';
import { TooltipProvider } from '../components/ui/tooltip';
import { Sidebar } from '../components/shell/sidebar';
import { Topbar } from '../components/shell/topbar';
import { CommandPalette } from '../components/shell/command-palette';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jbmono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Lisans Paneli — Tedarik & Yönetim',
  description: 'Merkezi lisans stok, tedarik ve teslimat paneli',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Arayüz Türkçe-öncelikli (§17).
  return (
    <html lang="tr" suppressHydrationWarning className={`${inter.variable} ${mono.variable}`}>
      <body>
        <ThemeProvider>
          <TooltipProvider delayDuration={200}>
            <div className="flex min-h-screen">
              <Sidebar />
              <div className="flex min-w-0 flex-1 flex-col">
                <Topbar />
                <main className="min-w-0 flex-1 px-5 py-6 md:px-8 md:py-8">{children}</main>
              </div>
            </div>
            <CommandPalette />
            <Toaster
              position="bottom-right"
              toastOptions={{
                classNames: {
                  toast:
                    'rounded-[var(--radius-md)] border border-border bg-surface-raised text-ink shadow-lg',
                },
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
