import { ShieldOff } from 'lucide-react';
import { apiGet, type QuarantineRow } from '../../lib/api';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { QuarantineTable } from '../../components/quarantine-table';

export const dynamic = 'force-dynamic';

export default async function QuarantinePage() {
  let rows: QuarantineRow[] = [];
  let error: string | null = null;
  try {
    rows = await apiGet<QuarantineRow[]>('/v1/admin/quarantine');
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        icon={ShieldOff}
        title="Karantina"
        description="Değiştirilen/iade edilen ölü anahtarlar — satışa dönmez."
      />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <QuarantineTable rows={rows} />
      )}
    </div>
  );
}
