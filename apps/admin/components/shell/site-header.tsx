'use client';
import * as React from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { NAV } from './nav';
import { ThemeToggle } from '../theme';
import { PresenceIndicator } from '../presence-indicator';
import { NotificationBell } from '../live/notification-bell';
import { useLive } from '../live/live-provider';
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
  // NAV'dan türeyen anahtarlar tek segmenttir ('/stock/import' → 'stock/import' asla eşleşmez),
  // bu yüzden çok segmentli rotaların son parçası burada elle karşılanır.
  import: 'Stok Girişi',
  // NAV'da yok (ürün listesi /stock altında) ama breadcrumb yol parçalarından üretildiği
  // için '/products/[id]' sayfasında ara segment olarak çıkar → etiketsiz kalırsa ham
  // İngilizce "products" görünürdü. Link'i app/products/page.tsx /stock'a yönlendirir.
  products: 'Ürünler',
  // '/quarantine/claims[/id]' segmenti — etiketsiz kalırsa ham İngilizce "claims" çıkar.
  claims: 'Değişim Fişleri',
  // '/quarantine/records' (kusurlu stok defteri) — aynı gerekçe: ham "records" görünürdü.
  records: 'Tüm Kayıtlar',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function labelFor(segment: string): string {
  if (LABELS[segment]) return LABELS[segment];
  // Kayıt id'si (UUID) breadcrumb'da ham gösterilmez.
  if (UUID_RE.test(segment)) return 'Detay';
  return decodeURIComponent(segment);
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

      <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
        {/*
          Arama tetiği: dar ekranda YALNIZ ikon (kare, h-8 — diğer üst bar öğeleriyle aynı
          yükseklik), `sm` ve üstünde metin + kısayol rozeti. Eskiden `w-full max-w-56` idi
          ve dar ekranda diğer öğeleri eziyordu.
        */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('open-command'))}
          aria-label="Ara"
          title="Ara (Ctrl+K)"
          className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground sm:w-52 sm:justify-start sm:gap-2 sm:px-2.5 sm:text-xs"
        >
          <Search className="size-4 shrink-0 sm:size-3.5" />
          <span className="hidden flex-1 text-left sm:inline">Ara…</span>
          <kbd className="hidden h-5 items-center rounded border border-border px-1.5 font-sans text-[10px] font-medium leading-none text-muted-foreground sm:inline-flex">
            Ctrl K
          </kbd>
        </button>

        {/* Bildirim çanı — kendi isteğini AÇMAZ, paylaşılan canlı akıştan (useLive) okur. */}
        <NotificationBell />

        {/* Operatör çakışma uyarısı (§14) — aynı sayfada başka admin varsa görünür.
            Metni uzun olduğundan dar ekranda gizlenir (üst bar taşmasın). */}
        <div className="hidden h-8 items-center md:flex">
          <PresenceIndicator />
        </div>

        <LiveStatus />
        <ThemeToggle />
      </div>
    </header>
  );
}

/**
 * Canlı akış durumu — GERÇEK duruma bağlı (eskiden sabit "CANLI" yazıyordu, yanıltıcıydı).
 * Dar ekranda gizlidir; orada aynı bilgiyi bildirim çanının yanındaki uyarı ikonu verir.
 */
function LiveStatus() {
  const { errorCount, updatedAt } = useLive();
  const ok = errorCount === 0;
  const connecting = ok && updatedAt === 0;

  // updatedAt SSR'da her zaman 0 → sunucu/istemci ilk render'ı aynı (hydration uyumsuzluğu yok).
  const last =
    updatedAt > 0
      ? new Date(updatedAt).toLocaleTimeString('tr-TR', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZone: 'Europe/Istanbul',
        })
      : null;

  const title = connecting
    ? 'Canlı akış başlatılıyor…'
    : ok
      ? `Canlı akış çalışıyor${last ? ` — son güncelleme ${last}` : ''}`
      : `Canlı akışa ulaşılamıyor, yeniden deneniyor${last ? ` — son güncelleme ${last}` : ''}`;

  return (
    <Badge
      variant={connecting ? 'outline' : ok ? 'success' : 'warning'}
      className="hidden h-6 shrink-0 sm:inline-flex"
      title={title}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {/* Renk tek başına bilgi taşımasın (WCAG 1.4.1) — durum metni ekran okuyucuda da net. */}
      <span className="sr-only">Canlı akış durumu: </span>
      {connecting ? 'BAĞLANIYOR' : ok ? 'CANLI' : 'BAĞLANTI YOK'}
    </Badge>
  );
}
