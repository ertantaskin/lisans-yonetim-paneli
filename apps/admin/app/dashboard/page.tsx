import Link from 'next/link';
import {
  ShoppingCart,
  Boxes,
  ShieldAlert,
  Inbox,
  Globe,
  Truck,
  Link2,
  LayoutDashboard,
  TriangleAlert,
} from 'lucide-react';
import { getDashboard, type DashboardSummary } from './queries';
import { apiGet } from '../../lib/api';
import { PageHeader } from '../../components/ui/page-header';
import { StatStrip } from '../../components/ui/stat-tile';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import {
  LiveKpiStrip,
  LiveOrdersCard,
  LiveStatus,
  LiveSupportCard,
} from '../../components/live/live-feed';
import type { LivePayload } from '../../lib/live-types';

export const dynamic = 'force-dynamic';

/**
 * Sunucu tarafındaki ilk kare için satır sayısı. `LiveProvider`'ın varsayılan `limit`
 * değeriyle AYNI olmalı (components/live/live-provider.tsx) — aksi halde ilk canlı poll
 * listenin uzunluğunu değiştirir ve ekran zıplar.
 */
const LIVE_LIMIT = 15;

/** Alt satır hızlı erişim kısayolları (kabuk navigasyonuyla aynı hedefler). */
const QUICK_LINKS: Array<{ label: string; href: string; icon: typeof Inbox }> = [
  { label: 'Bekleyen Teslimatlar', href: '/pending', icon: Inbox },
  { label: 'Siparişler', href: '/orders', icon: ShoppingCart },
  { label: 'Stok & Ürünler', href: '/stock', icon: Boxes },
  { label: 'Ürün Eşleştirme', href: '/mappings', icon: Link2 },
  { label: 'Kanallar / Siteler', href: '/sites', icon: Globe },
  { label: 'Tedarikçiler', href: '/suppliers', icon: Truck },
];

/**
 * Genel Bakış = operatörün İŞ İSTASYONU (§17). Mesai boyunca açık kalması tasarlanmıştır:
 *
 *  1. Sunucu, canlı akışın İLK KARESİNİ de çeker (`/v1/admin/live`) → sayaçlar ve iki liste
 *     ilk boyamada DOLU gelir; ekran asla boş/iskelet açılmaz.
 *  2. Sonrasını `useLive()` devralır: panel genelinde TEK poll (15 sn, ETag'li, sekme
 *     arkadayken duraklar) — bu ekran kendi isteğini AÇMAZ. Yeni kayıtlar kısa süre vurgulanır.
 *  3. Canlı akışta olmayan yavaş metrikler (bugünkü sipariş / stok / güvenlik) altta ince
 *     bir şeritte sunucu özetiyle durur — gürültü yapmadan bağlam verir.
 *
 * İki çekim BAĞIMSIZ: özet başarısız olsa bile sayfa render edilir (yalnız uyarı bandı çıkar),
 * anlık görüntü başarısız olsa bile istemci poll'u devreye girip listeleri doldurur.
 */
export default async function DashboardOverviewPage() {
  // İki bağımsız çekim PARALEL ve birbirinden BAĞIMSIZ hataya dayanıklı:
  //  • summary  → yavaş metrikler (bugünkü sipariş / stok / güvenlik)
  //  • snapshot → canlı akışın İLK karesi (istemci poll'unun döneceği gövdenin aynısı)
  // Snapshot sunucuda bir kez alınır; sonrasını tek canlı poller devralır (ek istek yok).
  const [summaryRes, snapshotRes] = await Promise.allSettled([
    getDashboard(),
    apiGet<LivePayload>(`/v1/admin/live?limit=${LIVE_LIMIT}`),
  ]);

  const data: DashboardSummary | null =
    summaryRes.status === 'fulfilled' ? summaryRes.value : null;
  const error =
    summaryRes.status === 'rejected'
      ? summaryRes.reason instanceof Error
        ? summaryRes.reason.message
        : 'Bağlantı hatası'
      : null;

  // `null` tohum = sunucu da veremedi → akış kartları "kayıt yok" yerine iskelet gösterir.
  const snapshot: LivePayload | null =
    snapshotRes.status === 'fulfilled' ? snapshotRes.value : null;

  return (
    <div className="space-y-4">
      <PageHeader
        icon={LayoutDashboard}
        title="Genel Bakış"
        description="İş istasyonu — gelen siparişler ve destek talepleri canlı olarak buradan izlenir."
      >
        <LiveStatus />
      </PageHeader>

      {error && (
        <Alert variant="warning">
          <TriangleAlert />
          <div>
            <AlertTitle>Sunucu özeti yüklenemedi</AlertTitle>
            <AlertDescription>
              {error} — canlı akış ayrı yoldan beslenir, aşağıdaki listeler çalışmaya devam eder.
            </AlertDescription>
          </div>
        </Alert>
      )}

      {/* Canlı iş kuyrukları: her hücre ilgili çalışma ekranına bağlantı */}
      <LiveKpiStrip initialStats={snapshot?.stats} />

      {/* Ana akış: solda siparişler, sağda destek talepleri */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <LiveOrdersCard initialOrders={snapshot?.orders ?? null} />
        <LiveSupportCard initialSupports={snapshot?.supports ?? null} />
      </div>

      {/* Yavaş metrikler (sunucu özeti) — canlı akışta yer kaplamasın diye ince şeritte */}
      {data && (
        <StatStrip
          items={[
            { icon: ShoppingCart, label: 'Bugünkü sipariş', value: data.todayOrders },
            {
              icon: Boxes,
              label: 'Atanabilir stok',
              value: data.totalAvailableStock.toLocaleString('tr-TR'),
            },
            {
              icon: ShieldAlert,
              label: 'Güvenlik olayı',
              value: data.openSecurityEvents,
              hint: 'son 7 gün',
              tone: data.openSecurityEvents > 0 ? 'warning' : 'default',
            },
          ]}
        />
      )}

      {/* Hızlı erişim */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-medium text-muted-foreground">Hızlı erişim</span>
        {QUICK_LINKS.map((l) => {
          const Icon = l.icon;
          return (
            <Button key={l.href} asChild variant="outline" size="sm">
              <Link href={l.href}>
                <Icon className="size-3.5" /> {l.label}
              </Link>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
