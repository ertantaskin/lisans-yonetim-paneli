import Link from 'next/link';
import { PackageCheck, PackagePlus } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
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
        icon={PackageCheck}
        title="Partiler"
        description="Bir partide gelen anahtarların tedarikçi/tarih izi: satılmamış-satılmış adet ve geri çekme (recall). Parti, Stok Girişi'nde tedarikçi + alım tarihi girildiğinde (satır 'Otomatik' rozetli olur) ya da bir satın alma emri teslim alındığında oluşur."
      >
        <Button asChild variant="outline">
          <Link href="/stock/import">
            <PackagePlus /> Stok Girişi
          </Link>
        </Button>
      </PageHeader>
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
