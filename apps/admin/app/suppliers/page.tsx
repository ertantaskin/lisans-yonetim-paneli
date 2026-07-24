import { PageHeader } from '@/components/ui/page-header';
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
      <PageHeader title="Tedarikçiler" description="Lisans/key tedarikçileri — satın alma emirleri ve partiler buraya bağlanır." />

      <Card className="mb-5 max-w-2xl">
        <CardContent className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-foreground">Yeni Tedarikçi</h2>
          <CreateSupplierForm />
        </CardContent>
      </Card>

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
