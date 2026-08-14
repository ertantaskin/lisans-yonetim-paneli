import { PackageSearch } from 'lucide-react';
import { PageHeader } from '../../../components/ui/page-header';
import { Card } from '../../../components/ui/card';
import { ReportsReorderView } from '../../../components/reports-reorder-view';
import { getReorderReport, type ReorderReport } from '../queries';

export const dynamic = 'force-dynamic';

/**
 * Yeniden-sipariş önerisi — "tedarik süresi içinde tükenecekler".
 *
 * Parametresiz: formülün girdileri (pencere / emniyet payı / hedef stok günü) sunucudaki
 * sabitlerdir ve yanıtla birlikte gelir → ekrandaki açıklama metni onlardan yazılır, iki
 * farklı sayı dolaşıma girmez.
 */
export default async function ReorderReportPage() {
  let data: ReorderReport | null = null;
  let error: string | null = null;
  try {
    data = await getReorderReport();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        icon={PackageSearch}
        title="Yeniden Sipariş Önerisi"
        description="Sabit düşük-stok eşiği tedarikçinin teslim süresini bilmez. Bu rapor tahmini tükenme tarihini tedarik süresiyle karşılaştırır: mal gelene kadar tükenecek ürünleri şimdi gösterir."
      />

      {error || !data ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API&apos;ye ulaşılamadı: {error ?? 'Veri yok'}</p>
        </Card>
      ) : (
        <ReportsReorderView data={data} />
      )}
    </div>
  );
}
