import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { DeadLetterTable } from '../../components/dead-letter-table';
import { MaintenanceCard } from './maintenance-card';
import { getDeadLetter, type DeadLetterRow } from './queries';

export const dynamic = 'force-dynamic';

export default async function OpsPage() {
  let rows: DeadLetterRow[] = [];
  let error: string | null = null;
  try {
    rows = await getDeadLetter();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        title="Dead-letter"
        description="Başarısız geri-kanal webhook olayları ve mail teslimleri — tek tıkla yeniden kuyruğa al."
      />
      <MaintenanceCard />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <DeadLetterTable rows={rows} />
      )}
    </div>
  );
}
