import Link from 'next/link';
import { Timer } from 'lucide-react';
import { PageHeader } from '../../../components/ui/page-header';
import { Card } from '../../../components/ui/card';
import { ReportsSlaView } from '../../../components/reports-sla-view';
import {
  SLA_DAY_OPTIONS,
  getSlaReport,
  normalizeSlaDays,
  type SlaReport,
} from '../queries';

export const dynamic = 'force-dynamic';

/**
 * Teslimat süresi (SLA) raporu — "sipariş düştükten kaç dakika sonra müşteri anahtarı aldı?".
 *
 * Pencere seçimi adres çubuğundadır (`?days=`) → paylaşılabilir/yer imlenebilir ve JS'siz
 * çalışır (düz `<Link>`; istemci durumu yok). Geçersiz değer ekranı BOŞALTMAZ: hem burada
 * hem API'de varsayılana (30 gün) düşer.
 */
export default async function SlaReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { days: daysRaw } = await searchParams;
  const days = normalizeSlaDays(daysRaw);

  let data: SlaReport | null = null;
  let error: string | null = null;
  try {
    data = await getSlaReport(days);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        icon={Timer}
        title="Teslimat Süresi"
        description="Sipariş panele düştükten sonra müşteri anahtarı kaç dakikada aldı? Ortalama tek başına yanıltıcıdır — medyan (p50) ve p95 ile birlikte okuyun."
      >
        <nav aria-label="Zaman aralığı" className="flex items-center gap-1">
          {SLA_DAY_OPTIONS.map((d) => (
            <Link
              key={d}
              href={`/reports/sla?days=${d}`}
              aria-current={d === days ? 'page' : undefined}
              className={
                d === days
                  ? 'rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground'
                  : 'rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground'
              }
            >
              {d} gün
            </Link>
          ))}
        </nav>
      </PageHeader>

      {error || !data ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API&apos;ye ulaşılamadı: {error ?? 'Veri yok'}</p>
        </Card>
      ) : (
        <ReportsSlaView data={data} />
      )}
    </div>
  );
}
