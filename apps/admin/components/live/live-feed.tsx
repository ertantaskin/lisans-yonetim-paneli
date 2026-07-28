'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Ban,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Inbox,
  LifeBuoy,
  Link2,
  Mail,
  PackageSearch,
  PackageX,
  RefreshCw,
  ShieldAlert,
  ShoppingCart,
  Unlink,
  type LucideIcon,
} from 'lucide-react';
import { useLive } from './live-provider';
import type { LiveOrder, LiveStats, LiveSupport } from '../../lib/live-types';
import { badgeStatusLabel, orderStatusLabel, supportStatusLabel } from '../../lib/labels';
import { cn, fmtDateTime } from '../../lib/utils';
import { Badge, type BadgeProps } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Skeleton } from '../ui/skeleton';

/**
 * İş istasyonu canlı akışı (§17) — genel bakış ekranının "borsa ekranı" katmanı.
 *
 * TEK VERİ KAYNAĞI `useLive()`: bu dosyadaki hiçbir bileşen kendi fetch/interval'ini AÇMAZ
 * (kullanıcı: "tarayıcımda hep açık kalacak, gereksiz yük olmasın"). Sağlayıcı 15 sn'de bir
 * koşullu (ETag) poll yapar, sekme gizliyken durur, hata olunca geri çekilir.
 *
 * İlk boyama: sunucu bileşeni `initial*` ile taze veriyi geçirir → ekran asla boş açılmaz;
 * canlı yanıt gelince (`updatedAt > 0`) kontrol tamamen canlı veriye devreder.
 *
 * Hydration: göreli zaman `Date.now()` ister ve SSR/CSR'de ayrışır → mount öncesi SABİT
 * timezone'lu saat (deterministik), mount sonrası göreli etiket gösterilir.
 */

// ── Ortak yardımcılar ────────────────────────────────────────────────────────

/** Mount sonrası true — istemciye özgü (Date.now bağımlı) çıktıyı SSR'den ayırmak için. */
function useMounted(): boolean {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * Göreli zaman ("az önce", "7 dk", "3 sa", "2 g") — YEREL yardımcı, dış bağımlılık yok.
 * Yoğun akış satırında yer kazanmak için kısa biçim kullanılır; tam tarih `title`'da durur.
 * 7 günden eskiler mutlak tarihe düşer.
 */
function relLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'az önce'; // saat sapmasıyla gelecek tarihli kayıtlar da buraya düşer
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} dk`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} sa`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} g`;
  return new Date(t).toLocaleDateString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Europe/Istanbul',
  });
}

/** SABİT timezone'lu saat (SSR ve istemcide AYNI çıktı → hydration ayrışmaz). */
function clockLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Istanbul',
  });
}

function TimeCell({ iso, mounted }: { iso: string; mounted: boolean }) {
  return (
    <time
      dateTime={iso}
      title={fmtDateTime(iso)}
      className="w-[3.25rem] shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground"
    >
      {mounted ? relLabel(iso) : clockLabel(iso)}
    </time>
  );
}

type BadgeVariant = NonNullable<BadgeProps['variant']>;
interface StatusMeta {
  variant: BadgeVariant;
  label: string;
  icon: LucideIcon;
}

/**
 * Sipariş durumu → rozet. Etiket TEK KAYNAK `lib/labels.ts` (ham enum operatöre çıkmaz);
 * `held` bayrağı ham durumu EZER — panelin yetkili "İncelemede" işareti odur (§8).
 */
function orderBadge(o: LiveOrder): StatusMeta {
  if (o.held) {
    return { variant: 'warning', label: orderStatusLabel('held_for_review'), icon: ClipboardCheck };
  }
  switch (o.status) {
    // Eşlenmemiş sipariş: mağaza ürünü panel ürününe bağlanmadığı için TESLİM EDİLEMEZ —
    // operatörün eşlemeyi yapması gerekir, o yüzden en yüksek görsel öncelik (danger).
    // Etiket rozet sözlüğünden ("Eşlenmemiş"): `ORDER_STATUS`'te karşılığı YOK, oradan
    // okunsa ham enum ('unmapped') operatöre çıkardı. `StatusBadge` ile birebir aynı metin.
    case 'unmapped':
      return { variant: 'danger', label: badgeStatusLabel('unmapped'), icon: ShieldAlert };
    case 'fulfilled':
      return { variant: 'success', label: orderStatusLabel('fulfilled'), icon: CheckCircle2 };
    case 'partial':
      return { variant: 'warning', label: orderStatusLabel('partial'), icon: Clock };
    case 'pending':
      return { variant: 'warning', label: orderStatusLabel('pending'), icon: Clock };
    case 'revoked':
      return { variant: 'danger', label: orderStatusLabel('revoked'), icon: Ban };
    case 'canceled':
    case 'cancelled':
      return { variant: 'danger', label: orderStatusLabel('canceled'), icon: Ban };
    default:
      return { variant: 'neutral', label: orderStatusLabel(o.status), icon: Clock };
  }
}

/**
 * Eşleme uyarısının ipucu metni. Siparişin BÜTÜNÜYLE mi yoksa yalnız BİR KALEMİNİN mi
 * eşlemesiz olduğunu ayırır — çok kalemli siparişte "sipariş eşlenmemiş" demek yanlış olur
 * (diğer kalemler teslim edilmiş olabilir). Satır sayacı ("N/M satır") bu satırda uyarı
 * metnine yerini bıraktığı için bilgi kaybolmasın diye ipucuna taşınır.
 */
function unmappedHint(o: LiveOrder): string {
  return [
    o.status === 'unmapped'
      ? 'Bu siparişteki mağaza ürünü panel ürününe bağlı değil — eşleme yapılana kadar teslim edilemez.'
      : 'Bu siparişte en az bir kalem panel ürününe bağlı değil — o kalem(ler) eşleme yapılana kadar teslim edilemez.',
    o.lineCount > 0 ? `${o.lineCount} satırın ${o.fulfilledLines} tanesi teslim edildi.` : null,
    'Siparişi açıp eşlemeyi yapın.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Destek/değişim talebi durumu → rozet (etiketler `supportStatusLabel`). */
function supportBadge(status: string): StatusMeta {
  switch (status) {
    case 'open':
      return { variant: 'warning', label: supportStatusLabel('open'), icon: Clock };
    case 'info_requested':
      return { variant: 'warning', label: supportStatusLabel('info_requested'), icon: Mail };
    case 'approved':
      return { variant: 'success', label: supportStatusLabel('approved'), icon: CheckCircle2 };
    case 'rejected':
      return { variant: 'danger', label: supportStatusLabel('rejected'), icon: Ban };
    default:
      return { variant: 'neutral', label: supportStatusLabel(status), icon: Clock };
  }
}

/**
 * Akış satırının ortak kabuğu. YENİ kayıt vurgusu: sol kenarda aksan şerit + hafif zemin,
 * CSS geçişiyle (sağlayıcı ~12 sn sonra `fresh` kümesini boşaltır → vurgu söner).
 * SÜREKLİ animasyon YOK; `prefers-reduced-motion` açıkken geçiş de kapanır.
 *
 * `alert` = operatör aksiyonu bekleyen satır (ör. eşlenmemiş sipariş): `fresh`ten farklı
 * olarak SÖNMEZ — iş yapılana kadar durur, bu yüzden `fresh`ten SONRA uygulanır (twMerge
 * son sınıfı kazandırır → sol şerit ve zemin uyarı tonuna sabitlenir).
 */
function FeedRow({
  href,
  fresh,
  alert = false,
  children,
}: {
  href: string;
  fresh: boolean;
  alert?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="border-b border-border last:border-b-0">
      <Link
        href={href}
        className={cn(
          'flex items-center gap-2.5 border-l-2 border-l-transparent px-3 py-2 outline-none transition-colors duration-500 motion-reduce:transition-none',
          'hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60',
          fresh && 'border-l-primary bg-accent/60',
          alert &&
            'border-l-destructive bg-[color-mix(in_oklch,var(--destructive)_8%,transparent)] hover:bg-[color-mix(in_oklch,var(--destructive)_14%,transparent)]',
        )}
      >
        {fresh && <span className="sr-only">Yeni: </span>}
        {children}
      </Link>
    </li>
  );
}

/** Akış kartı kabuğu: başlık + sayaç + "Tümü" bağlantısı + yoğun liste gövdesi. */
function FeedCard({
  title,
  icon: Icon,
  count,
  href,
  hrefLabel,
  children,
}: {
  title: string;
  icon: LucideIcon;
  count: number;
  href: string;
  hrefLabel: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-center justify-between gap-2 px-3.5 pb-2 pt-3.5">
        <CardTitle icon={Icon} className="text-[13px]">
          {title}
          {count > 0 && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
              {count}
            </span>
          )}
        </CardTitle>
        <Button asChild variant="ghost" size="sm" className="-mr-1 h-7 px-2 text-[11px]">
          <Link href={href}>
            {hrefLabel} <ArrowRight className="size-3.5" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="border-t border-border p-0">{children}</CardContent>
    </Card>
  );
}

function RowSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul aria-busy="true" aria-label="Yükleniyor">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
          <Skeleton className="h-3 w-9" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-2.5 w-3/5" />
          </div>
          <Skeleton className="h-4 w-16 rounded-full" />
        </li>
      ))}
    </ul>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <p className="px-4 py-12 text-center text-xs text-muted-foreground">{text}</p>;
}

// ── Canlı durum göstergesi (sayfa başlığında) ────────────────────────────────

/**
 * Nabız noktası + son güncelleme saati + elle "Yenile".
 *
 * `updatedAt` yalnız GÖVDE değiştiğinde ilerler: sunucu 304 döndüğünde (veri aynı) damga
 * kasıtlı olarak sabit kalır → "son güncelleme" = "verinin son değiştiği an".
 */
export function LiveStatus({ className }: { className?: string }) {
  const { updatedAt, errorCount, refresh } = useLive();
  const mounted = useMounted();
  const [busy, setBusy] = React.useState(false);
  const problem = errorCount > 0;

  // Tek atımlık görsel geri bildirim (poller DEĞİL): kendini iptal eden tek setTimeout.
  React.useEffect(() => {
    if (!busy) return;
    const t = window.setTimeout(() => setBusy(false), 900);
    return () => window.clearTimeout(t);
  }, [busy]);

  const stamp =
    mounted && updatedAt > 0
      ? new Date(updatedAt).toLocaleTimeString('tr-TR', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      : null;

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px]',
          problem ? 'text-warning' : 'text-muted-foreground',
        )}
        title={
          problem
            ? 'Canlı bağlantı kesildi, otomatik yeniden deneniyor.'
            : 'Veriler arka planda otomatik tazelenir (sekme arkada kaldığında duraklar).'
        }
      >
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            problem ? 'bg-warning' : 'bg-success animate-pulse motion-reduce:animate-none',
          )}
        />
        {problem ? (
          'Bağlantı yeniden kuruluyor…'
        ) : (
          <>
            Canlı
            {stamp && <span className="tabular-nums">· son güncelleme {stamp}</span>}
          </>
        )}
      </span>

      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setBusy(true);
          refresh();
        }}
        title="Canlı verileri şimdi yenile"
      >
        <RefreshCw className={cn(busy && 'animate-spin motion-reduce:animate-none')} />
        Yenile
      </Button>
    </div>
  );
}

// ── Canlı KPI şeridi ─────────────────────────────────────────────────────────

/**
 * KPI tonu — hücrenin OPERATÖRE söylediği şey:
 *  • danger  = teslimatı fiilen durduran iş (eşleme bekleyen sipariş/satır)
 *  • warning = sıradaki iş (bekleyen satır, inceleme, destek)
 *  • info    = BİLGİ, alarm DEĞİL: doğru çalışan sistemde de kalıcı > 0 olabilen sayaç.
 *              Kırmızı/sarı verilirse hiçbir doğru işlemle sönmez → alarm körlüğü.
 */
type KpiTone = 'warning' | 'danger' | 'info';

/** Sıfırdan büyükken (hot) kullanılan renk. `info` nötr kalır: okunur ama alarm değil. */
const KPI_TONE_TEXT: Record<KpiTone, string> = {
  danger: 'text-destructive',
  warning: 'text-warning',
  info: 'text-foreground',
};

interface KpiItem {
  key: keyof LiveStats;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Sıfırdan büyükken kullanılacak vurgu tonu (0 ise daima sönük). */
  tone: KpiTone;
  /** Hücrenin `title` ipucu — sayaç yanlış okunuyorsa anlamını açar. */
  hint?: string;
}

const KPI_ITEMS: KpiItem[] = [
  {
    key: 'pendingLines',
    label: 'Bekleyen satır',
    href: '/pending',
    icon: Inbox,
    tone: 'warning',
    hint: 'Panel ürününe bağlı ama henüz teslim edilmemiş sipariş satırları (stok/tamamlama bekliyor).',
  },
  {
    key: 'unmappedLines',
    label: 'Eşlenmemiş satır',
    href: '/mappings',
    icon: Link2,
    tone: 'danger',
    hint: 'Mağaza ürünü panel ürününe bağlı olmadığı için teslim edilemeyen sipariş satırları.',
  },
  { key: 'heldOrders', label: 'İnceleme kuyruğu', href: '/review', icon: ClipboardCheck, tone: 'warning' },
  { key: 'openSupport', label: 'Açık destek', href: '/support', icon: LifeBuoy, tone: 'warning' },
  { key: 'lowStockProducts', label: 'Düşük stok', href: '/stock', icon: PackageX, tone: 'danger' },
];

/**
 * YALNIZ sıfırdan büyükken çizilen ek sayaçlar. Sürekli görünen sayaçlardan AYRI tutulur
 * çünkü: (a) API eski sürümdeyse alan hiç gelmez (undefined) — sönük "—" hücresi yanlış
 * güven verirdi, (b) 0 iken şeritte yer kaplamamalı (dikkat yalnız iş olan yerde).
 *
 * TON AYRIMI kritik: yalnız `unmappedOrders` bir ALARM'dır (gerçek talep, eşleme kurulunca
 * söner). `unmappedCatalogProducts` BİLGİ'dir — katalog mağazanın TÜM ürünlerini taşır
 * (kargo/hizmet/fiziksel dahil), "eşlenmemiş" ≠ "eşlenmesi gereken"; kırmızı verilseydi
 * hiçbir doğru işlemle sönmez, operatörü lisans taşımayan ürünleri de eşlemeye iterdi.
 */
const ALERT_KPI_ITEMS: KpiItem[] = [
  {
    key: 'unmappedOrders',
    label: 'Eşleme bekleyen sipariş',
    href: '/pending',
    icon: Unlink,
    tone: 'danger',
    hint: 'En az bir kalemi panel ürününe bağlı olmayan bekleyen sipariş — o kalemler eşleme yapılana kadar teslim edilemez.',
  },
  {
    key: 'unmappedCatalogProducts',
    label: 'Panelde eşlenmemiş mağaza ürünü',
    href: '/mappings',
    icon: PackageSearch,
    tone: 'info',
    hint: 'Bilgi amaçlı: mağaza kataloğunda panel ürününe bağlanmamış ürün sayısı. Hepsinin eşlenmesi gerekmez — yalnız lisans taşıyanları eşleyin.',
  },
];

/**
 * Görünen hücre sayısına göre lg kolon sayısı. Şerit lg'de HER ZAMAN tek satır olmalı:
 * `gap-px` + `bg-border` düzeninde eksik hücre, ayraç rengiyle dolu boş bir blok gibi
 * görünür. Tailwind sınıfları statik yazılır (dinamik string derlemeye girmez).
 */
const LG_COLS: Record<number, string> = {
  5: 'lg:grid-cols-5',
  6: 'lg:grid-cols-6',
  7: 'lg:grid-cols-7',
};

/**
 * Üstteki ince canlı sayaç şeridi — operatörün "şu an neye bakmalıyım" listesi.
 * Her hücre ilgili çalışma kuyruğuna bağlantıdır; sıfır olan hücreler sönük durur
 * (dikkat yalnız iş olan yere gitsin).
 */
export function LiveKpiStrip({ initialStats }: { initialStats?: Partial<LiveStats> }) {
  const { data, updatedAt } = useLive();
  const hasLive = updatedAt > 0;

  /**
   * Sayaç okuma — SAVUNMACI: alan gelmemişse (eski API / dağıtım sapması) `null` döner,
   * `null` "veri yok" demektir ve alarm üretmez (yanlış alarm yok).
   */
  const readStat = (key: keyof LiveStats): number | null => {
    const raw = hasLive ? data.stats[key] : initialStats?.[key];
    return typeof raw === 'number' ? raw : null;
  };

  const cells = [
    ...KPI_ITEMS.map((item) => ({ item, value: readStat(item.key) })),
    // Ek sayaçlar yalnız GERÇEKTEN değer varken (>0) şeride girer.
    ...ALERT_KPI_ITEMS.map((item) => ({ item, value: readStat(item.key) })).filter(
      (c) => (c.value ?? 0) > 0,
    ),
  ];

  // `gap-px` + `bg-border` = 1px ayraçlar. Tek sayıda hücre 2-kolon düzeninde BOŞ hücre
  // bırakır (ayraç rengi blok gibi görünürdü) → son hücre iki kolona yayılır (`spanLast`).
  return (
    <nav
      aria-label="Canlı iş kuyrukları"
      className={cn(
        'grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border',
        LG_COLS[cells.length] ?? 'lg:grid-cols-5',
      )}
    >
      {cells.map(({ item, value }, i) => {
        const Icon = item.icon;
        const hot = value !== null && value > 0;
        const spanLast = i === cells.length - 1 && cells.length % 2 === 1;
        return (
          <Link
            key={item.key}
            href={item.href}
            className={cn(
              'flex items-center gap-2 bg-card px-3 py-2.5 outline-none transition-colors',
              'hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60',
              spanLast && 'col-span-2 lg:col-span-1',
              !hot && 'text-muted-foreground',
            )}
          >
            <Icon
              className={cn(
                'size-4 shrink-0',
                // Sönük durumda da AA korunur: opaklık DÜŞÜRÜLMEZ, yalnız semantik renk düşer.
                hot ? KPI_TONE_TEXT[item.tone] : 'text-muted-foreground',
              )}
              aria-hidden
            />
            <span
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              title={item.hint ?? item.label}
            >
              {item.label}
            </span>
            <span
              className={cn(
                'shrink-0 text-base font-semibold tabular-nums',
                hot ? KPI_TONE_TEXT[item.tone] : 'text-muted-foreground',
              )}
            >
              {value !== null ? value.toLocaleString('tr-TR') : '—'}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

// ── Son siparişler ───────────────────────────────────────────────────────────

/**
 * Canlı sipariş akışı. `initialOrders` sunucu tarafında çekilen anlık görüntüden gelir
 * (ilk boyama DOLU) ve canlı yanıt gelir gelmez tamamen canlı listeye devredilir. Canlı uç
 * hiç yanıt veremezse (API kapalı) sunucu tohumu ekranda kalır → operatör boş ekranla kalmaz.
 * `null` tohum = "sunucu da veremedi" → iskelet gösterilir (yanıltıcı "kayıt yok" yazılmaz).
 */
export function LiveOrdersCard({ initialOrders = null }: { initialOrders?: LiveOrder[] | null }) {
  const { data, updatedAt, errorCount, fresh } = useLive();
  const mounted = useMounted();
  const hasLive = updatedAt > 0;
  const orders = hasLive ? data.orders : (initialOrders ?? []);
  const seeded = hasLive || initialOrders !== null;

  return (
    <FeedCard title="Son Siparişler" icon={ShoppingCart} count={orders.length} href="/orders" hrefLabel="Tümü">
      {orders.length === 0 ? (
        seeded ? (
          <EmptyRow text="Henüz sipariş yok." />
        ) : errorCount > 0 ? (
          <EmptyRow text="Canlı veri alınamadı, yeniden deneniyor…" />
        ) : (
          <RowSkeleton />
        )
      ) : (
        <ul>
          {orders.map((o) => {
            const meta = orderBadge(o);
            const Icon = meta.icon;
            // Eşleme bekleyen sipariş akışta KAYBOLMAMALI (operatör şikâyeti): satır kalıcı
            // uyarı tonuyla vurgulanır ve "N/M satır" sayacı yerine yapılacak iş yazılır.
            //
            // İKİ KAYNAK: (a) sipariş BÜTÜNÜYLE eşlemesizse durum 'unmapped' olur;
            // (b) çok kalemli siparişte tek kalem eşlemesizse durum 'pending'/'partial'
            // kalır ve yalnız `hasUnmappedLine` bunu söyler. Yukarıdaki KPI sayacı
            // (`stats.unmappedOrders`) SATIR tabanlı olduğu için (b) işaretlenmezse
            // "sayaç 1 diyor ama listede işaretli satır yok" çelişkisi doğuyordu.
            //
            // SAVUNMACI: alan eski API sürümünde hiç gelmeyebilir (`?? false`) → o durumda
            // davranış bugünküyle birebir aynı kalır (yalnız durum='unmapped' işaretlenir).
            const unmapped = o.status === 'unmapped' || (o.hasUnmappedLine ?? false);
            return (
              <FeedRow
                key={o.id}
                href={`/orders/${o.id}`}
                fresh={fresh.has(`o:${o.id}`)}
                alert={unmapped}
              >
                <TimeCell iso={o.createdAt} mounted={mounted} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                      #{o.remoteOrderId}
                    </span>
                    {o.siteDomain && (
                      <span className="truncate text-[11px] text-muted-foreground" title={o.siteDomain}>
                        {o.siteDomain}
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground" title={o.customerEmail}>
                    {o.customerEmail}
                  </span>
                </span>
                {unmapped ? (
                  <span
                    className="hidden shrink-0 text-[11px] font-medium text-destructive sm:inline"
                    title={unmappedHint(o)}
                  >
                    Eşleştirme gerekiyor
                  </span>
                ) : (
                  o.lineCount > 0 && (
                    <span
                      className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground sm:inline"
                      title={`${o.lineCount} satırın ${o.fulfilledLines} tanesi teslim edildi`}
                    >
                      {o.fulfilledLines}/{o.lineCount} satır
                    </span>
                  )
                )}
                <Badge variant={meta.variant} className="shrink-0">
                  <Icon />
                  {meta.label}
                </Badge>
              </FeedRow>
            );
          })}
        </ul>
      )}
    </FeedCard>
  );
}

// ── Son destek talepleri ─────────────────────────────────────────────────────

/**
 * Canlı destek/değişim talebi akışı. Satır, talebin bağlı olduğu SİPARİŞ DETAYINA gider
 * (orada talep kartından doğrudan Onayla/Reddet yapılabilir); sipariş bağı yoksa /support'a.
 * Tohum davranışı `LiveOrdersCard` ile aynı (`null` = sunucu da veremedi → iskelet).
 */
export function LiveSupportCard({
  initialSupports = null,
}: {
  initialSupports?: LiveSupport[] | null;
}) {
  const { data, updatedAt, errorCount, fresh } = useLive();
  const mounted = useMounted();
  const hasLive = updatedAt > 0;
  const supports: LiveSupport[] = hasLive ? data.supports : (initialSupports ?? []);
  const seeded = hasLive || initialSupports !== null;

  return (
    <FeedCard
      title="Son Destek Talepleri"
      icon={LifeBuoy}
      count={supports.length}
      href="/support"
      hrefLabel="Tümü"
    >
      {supports.length === 0 ? (
        seeded ? (
          <EmptyRow text="Henüz destek talebi yok." />
        ) : errorCount > 0 ? (
          <EmptyRow text="Canlı veri alınamadı, yeniden deneniyor…" />
        ) : (
          <RowSkeleton />
        )
      ) : (
        <ul>
          {supports.map((r) => {
            const meta = supportBadge(r.status);
            const Icon = meta.icon;
            const reason = r.reasonExcerpt?.trim() || 'Gerekçe belirtilmemiş.';
            return (
              <FeedRow
                key={r.id}
                href={r.orderId ? `/orders/${r.orderId}` : '/support'}
                fresh={fresh.has(`s:${r.id}`)}
              >
                <TimeCell iso={r.createdAt} mounted={mounted} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate text-sm font-medium text-foreground" title={r.customerEmail}>
                      {r.customerEmail}
                    </span>
                    {r.remoteOrderId && (
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        #{r.remoteOrderId}
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground" title={reason}>
                    {reason}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <Badge variant={meta.variant}>
                    <Icon />
                    {meta.label}
                  </Badge>
                  <span
                    className={cn(
                      'text-[10px] leading-none',
                      r.withinWarranty ? 'text-success' : 'text-muted-foreground',
                    )}
                  >
                    {r.withinWarranty ? 'Garanti içi' : 'Garanti dışı'}
                  </span>
                </span>
              </FeedRow>
            );
          })}
        </ul>
      )}
    </FeedCard>
  );
}
