import Link from 'next/link';
import { BarChart3, Coins, PackageSearch, Timer, type LucideIcon } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { ReportsView } from '../../components/reports-view';
import { getReportsOverview, type ReportsOverview } from './queries';

/** Alt raporlar — bu ekranın giriş noktaları (sol menüde ayrı satır AÇILMAZ, §17). */
const SUB_REPORTS: Array<{ href: string; icon: LucideIcon; title: string; description: string }> = [
  {
    href: '/reports/sla',
    icon: Timer,
    title: 'Teslimat Süresi',
    description:
      'Sipariş kaç dakikada teslim edildi (medyan · p95), hangi mağazada/üründe bekleme birikiyor.',
  },
  {
    href: '/reports/reorder',
    icon: PackageSearch,
    title: 'Yeniden Sipariş Önerisi',
    description:
      'Tedarik süresi içinde tükenecek ürünler — şimdi emir açılması gerekenler ve önerilen adet.',
  },
  {
    href: '/reports/costs',
    icon: Coins,
    title: 'Maliyet Raporu',
    description: 'Tedarik maliyeti, stok değerlemesi ve fire. Gelir/kâr İÇERMEZ.',
  },
];

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  let data: ReportsOverview | null = null;
  let error: string | null = null;
  try {
    data = await getReportsOverview();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        icon={BarChart3}
        title="Raporlar"
        description="Sipariş, teslimat, stok ve satış hızı — salt-okunur özet."
      />
      {/* Alt raporlar — kart olarak, çünkü artık üç tane var ve hangisinin ne cevapladığı
          tek satırlık bir bağlantıdan anlaşılmıyordu. */}
      <div className="mb-6 grid gap-3 [&>*]:min-w-0 sm:grid-cols-2 lg:grid-cols-3">
        {SUB_REPORTS.map(({ href, icon: Icon, title, description }) => (
          <Link
            key={href}
            href={href}
            className="group flex gap-3 rounded-xl border border-border bg-card p-4 shadow-xs transition-colors hover:border-primary/40"
          >
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground">
              <Icon className="size-4.5" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground group-hover:underline">
                {title} →
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                {description}
              </span>
            </span>
          </Link>
        ))}
      </div>
      {error || !data ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error ?? 'Veri yok'}</p>
        </Card>
      ) : (
        <ReportsView data={data} />
      )}
    </div>
  );
}
