'use client';
import * as React from 'react';
import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes';
import { Moon, Sun } from 'lucide-react';
import { Button } from './ui/button';

/** Koyu/açık tema — data-theme attribute'una yazar (globals.css ile hizalı). */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}

export function ThemeToggle() {
  const [mounted, setMounted] = React.useState(false);
  const { setTheme, resolvedTheme } = useTheme();
  React.useEffect(() => setMounted(true), []);

  // Mount öncesi (SSR + ilk render) sabit içerik → hydration uyumsuzluğu yok.
  if (!mounted) {
    return (
      <Button variant="ghost" size="icon-sm" aria-label="Temayı değiştir">
        <Moon />
      </Button>
    );
  }
  const isDark = resolvedTheme === 'dark';
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Temayı değiştir"
      title={isDark ? 'Açık tema' : 'Koyu tema'}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {isDark ? <Sun /> : <Moon />}
    </Button>
  );
}
