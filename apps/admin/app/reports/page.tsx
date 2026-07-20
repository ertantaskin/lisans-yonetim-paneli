import { PageHeader } from '../../components/ui';
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
        desc="Sipariş, teslimat, stok ve satış hızı — salt-okunur özet."
      />
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
