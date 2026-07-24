import Link from 'next/link';
import { Receipt } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { ReportsView } from '../../components/reports-view';
import { getReportsOverview, type ReportsOverview } from './queries';

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
        title="Raporlar"
        description="Sipariş, teslimat, stok ve satış hızı — salt-okunur özet."
      />
      <div className="mb-4 -mt-2">
        <Link
          href="/reports/costs"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline"
        >
          <Receipt className="size-4 text-muted-foreground" />
          Maliyet Raporu (tedarik maliyeti — gelir hariç) →
        </Link>
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
