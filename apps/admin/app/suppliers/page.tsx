import { PageHeader, Card } from '@/components/ui';
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
      <PageHeader title="Tedarikçiler" desc="Lisans/key tedarikçileri — satın alma emirleri ve partiler buraya bağlanır." />

      <Card className="mb-5 max-w-2xl">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Yeni Tedarikçi</h2>
        <CreateSupplierForm />
      </Card>

      {error ? (
        <Card>
          <p className="text-sm text-destructive">API&apos;ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <SuppliersTable suppliers={suppliers} />
      )}
    </div>
  );
}
