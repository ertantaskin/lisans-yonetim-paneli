import { Truck, Plus } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { CollapsiblePanel } from '@/components/ui/collapsible-panel';
import { Card, CardContent } from '@/components/ui/card';
import { CreateSupplierForm } from '@/components/create-supplier-form';
import { SuppliersTable } from '@/components/suppliers-table';
import { getSuppliers, type SupplierRow } from './queries';

export const dynamic = 'force-dynamic';

export default async function SuppliersPage() {
  let suppliers: SupplierRow[] = [];
  let error: string | null = null;
  try {
    suppliers = await getSuppliers();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        icon={Truck}
        title="Tedarikçiler"
        description="Anahtarları aldığınız tedarikçiler — satın alma emirleri, partiler ve maliyet raporu buraya bağlanır. Tedarikçiyi burada elle ekleyebilir ya da Stok Girişi'nde adını yazarak oluşturabilirsiniz (aynı adlı kayıt varsa yeniden kullanılır, mükerrer açılmaz)."
      />

      {/* Oluşturma formu VARSAYILAN KAPALI: tedarikçi eklemek seyrek bir iş, form sürekli
          açık durunca listeyi aşağı itiyordu (kullanıcı geri bildirimi). */}
      <CollapsiblePanel title="Yeni Tedarikçi" icon={<Plus />}>
        <CreateSupplierForm />
      </CollapsiblePanel>

      {error ? (
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-destructive">API&apos;ye ulaşılamadı: {error}</p>
          </CardContent>
        </Card>
      ) : (
        <SuppliersTable suppliers={suppliers} />
      )}
    </div>
  );
}
