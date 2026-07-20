import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Toaster } from 'sonner';
import { ThemeProvider } from '../components/theme';
import { TooltipProvider } from '../components/ui/tooltip';
import { AppShell } from '../components/shell/app-shell';
import { authEnabled, verifySession, SESSION_COOKIE } from '../lib/auth';
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

  // Oturumdaki admin (nav-user'da gösterilir). Auth kapalıysa null.
  const session = await verifySession(cookieStore.get(SESSION_COOKIE)?.value);
  const user = session
    ? { name: session.name, email: session.email, role: session.role }
    : undefined;

  // Arayüz Türkçe-öncelikli (§17).
  return (
    <html lang="tr" suppressHydrationWarning className={`${inter.variable} ${mono.variable}`}>
      <body>
        <ThemeProvider>
          <TooltipProvider delayDuration={200}>
            <AppShell defaultOpen={defaultOpen} user={user} authOff={!authEnabled()}>
              {children}
            </AppShell>
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
