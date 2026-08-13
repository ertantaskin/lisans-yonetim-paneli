import Link from 'next/link';
import { PackageCheck, PackagePlus, TriangleAlert } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { BatchesTable } from '../../components/batches-table';
import { getBatches, type BatchRow } from './queries';

export const dynamic = 'force-dynamic';

export default async function BatchesPage() {
  let batches: BatchRow[] = [];
  let truncated = false;
  let error: string | null = null;
  try {
    const res = await getBatches();
    batches = res.items;
    truncated = res.truncated;
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        icon={PackageCheck}
        title="Partiler"
        description="Bir partide gelen kalemlerin (anahtar/hesap/kod) tedarikçi ve tarih izi. Sayaçlar üç ayrı soruyu yanıtlar: kaçı hâlâ STOKTA (geri çekme bunları iptal eder), kaçı MÜŞTERİLERDE (çalışmaya devam eder, tek tek karar verirsiniz), kaçı DÜŞMÜŞ (iptal/karantina/iade/değiştirilmiş). Parti, Stok Girişi'nde tedarikçi + alım tarihi girildiğinde (satır 'Otomatik' rozetli olur) ya da bir satın alma emri teslim alındığında oluşur."
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
        <>
          {truncated && (
            <Alert variant="warning" className="mb-4">
              <TriangleAlert />
              <AlertDescription>
                En yeni <strong>500 parti</strong> gösteriliyor — daha eskileri bu listede yok.
                Aradığınız parti görünmüyorsa ürün detayındaki <strong>Tedarik</strong> sekmesinden
                ya da parti bağlantısıyla doğrudan açın.
              </AlertDescription>
            </Alert>
          )}
          <BatchesTable batches={batches} />
        </>
      )}
    </div>
  );
}
