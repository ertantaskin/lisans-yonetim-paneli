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
    // inset kabuk: içerik kartı md+'ta 8px boşlukla yüzer → sticky başlık viewport'un
    // 0'ına DEĞİL, kartın üst kenarına (top-2 = 8px) çakılmalı; aksi halde kaydırırken
    // kartın dışına 8px taşar. Zemin OPAK (eski yarı saydam + blur, yuvarlak kart kenarında
    // altındaki sayfa zeminini sızdırıyordu).
    // `md:rounded-t-xl` KOŞULSUZ: başlığın üstünde bir bant varsa (auth-kapalı uyarısı) köşe
    // kesiği kartın KENDİ zeminini açar — başlıkla aynı renk olduğu için görünmez; bant
    // kaydırılıp gidince de kartın üst köşesi doğru yuvarlak kalır.
    // `md:px-6`: yatay dolgu ana içerikle (`main` px-4 md:px-6) AYNI → üst bar öğeleri sayfa
    // içeriğiyle tek dikey eksende. Eskiden 16px vs 24px idi ve başlık çubuğu 17px kayık duruyordu.
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4 md:top-2 md:rounded-t-xl md:px-6">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-5" />

      {/* `min-w-0 flex-1 overflow-hidden`: breadcrumb ESNER ve taşarsa KENDİ İÇİNDE kırpılır.
          Eskiden sabit genişlikteydi → dar/orta ekranda sağdaki kontrolleri dışarı itiyordu
          (ölçüldü, 789px + açık menü: tema düğmesi x=791, üst barın sağ kenarı 771 → düğme
          üst barın DIŞINDA kalıp erişilemez oluyordu). */}
      <Breadcrumb className="hidden min-w-0 flex-1 overflow-hidden sm:block">
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

      {/* `shrink-0`: sağ blok ASLA kırpılmaz — kırpılırsa tema/bildirim gibi tek erişim yolu
          olan kontroller ulaşılamaz hale gelir. Esneme payı breadcrumb'dan alınır (yukarı bak). */}
      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
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
          // Referans deseni: gerçek bir arama ALANI gibi görünür (h-9, rounded-lg, shadow-xs,
          // solda ikon). Dar ekranda yine yalnız ikon — üst bardaki diğer öğeleri ezmesin.
          // Genişlik kademeli: orta genişlikte 176px, geniş ekranda 224px — sabit 224px,
          // açık menüyle birlikte orta ekranda sağ bloğu taşırıyordu.
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground sm:w-44 sm:justify-start sm:gap-2 sm:px-3 sm:text-sm lg:w-56"
        >
          <Search className="size-4 shrink-0" />
          <span className="hidden flex-1 text-left sm:inline">Ara…</span>
          <kbd className="hidden h-5 items-center rounded border border-border px-1.5 font-sans text-[10px] font-medium leading-none text-muted-foreground sm:inline-flex">
            Ctrl K
          </kbd>
        </button>

        {/* Bildirim çanı — kendi isteğini AÇMAZ, paylaşılan canlı akıştan (useLive) okur. */}
        <NotificationBell />

        {/* Operatör çakışma uyarısı (§14) — aynı sayfada başka admin varsa görünür.
            Metni uzun olduğundan dar ekranda gizlenir (üst bar taşmasın).
            `lg` (md DEĞİL): rozet ~190px ('N kişi daha bu sayfada') ve md=768px tam da üst barın
            en sıkışık olduğu genişlik — orada açık sidebar (256px) düşülünce header içerik kutusu
            rozetli gereksinimin altına iniyordu. lg'de yuva 1024−256=768px, kutu 736px, gereksinim
            ~655px ⇒ ~80px pay kalır. Bilgi kaybı yok: aynı içerik rozetin `title` ipucunda ve
            /security ekranında da var (LiveStatus'un `hidden sm:inline-flex` deseniyle tutarlı). */}
        <div className="hidden h-8 items-center lg:flex">
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
