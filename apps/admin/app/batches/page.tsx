import { PageHeader } from '../../components/ui';
import { Card } from '../../components/ui/card';
import { BatchesTable } from '../../components/batches-table';
import { getBatches, type BatchRow } from './queries';

export const dynamic = 'force-dynamic';

export default async function BatchesPage() {
  let batches: BatchRow[] = [];
  let error: string | null = null;
  try {
    batches = await getBatches();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        title="Partiler"
        desc="Tedarik partileri — satılmamış/satılmış adet ve geri çekme (recall)."
      />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <BatchesTable batches={batches} />
      )}
    </div>
  );
}
