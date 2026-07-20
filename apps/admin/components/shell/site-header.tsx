'use client';
import * as React from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { NAV } from './nav';
import { ThemeToggle } from '../theme';
import { Badge } from '../ui/badge';
import { Separator } from '../ui/separator';
import { SidebarTrigger } from '../ui/sidebar';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../ui/breadcrumb';

// href → etiket sözlüğü (NAV'dan türetilir) + statik segment etiketleri.
const LABELS: Record<string, string> = {
  ...Object.fromEntries(NAV.flatMap((s) => s.items).map((i) => [i.href.replace(/^\//, ''), i.label])),
  orders: 'Siparişler',
  pending: 'Bekleyen Teslimatlar',
  stock: 'Stok & Ürünler',
  sites: 'Kanallar / Siteler',
};

function labelFor(segment: string): string {
  return LABELS[segment] ?? decodeURIComponent(segment);
}

/** Üst bar: sidebar tetiği + breadcrumb + Ctrl+K arama + ortam rozeti + tema (§17). */
export function SiteHeader() {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/85 px-3 backdrop-blur-md md:px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-5" />

      <Breadcrumb className="hidden sm:block">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/">Panel</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {segments.map((seg, i) => {
            const href = '/' + segments.slice(0, i + 1).join('/');
            const last = i === segments.length - 1;
            return (
              <React.Fragment key={href}>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {last ? (
                    <BreadcrumbPage>{labelFor(seg)}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <Link href={href}>{labelFor(seg)}</Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </React.Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('open-command'))}
          className="group flex h-8 w-full max-w-56 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Ara…</span>
          <kbd className="hidden items-center gap-0.5 rounded border border-border px-1 py-0.5 text-[10px] font-medium sm:inline-flex">
            Ctrl K
          </kbd>
        </button>
        <Badge variant="success" className="hidden sm:inline-flex">
          <span className="size-1.5 rounded-full bg-current" />
          CANLI
        </Badge>
        <ThemeToggle />
      </div>
    </header>
  );
}
