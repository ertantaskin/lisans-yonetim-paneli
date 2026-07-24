import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { CustomersTable } from '../../components/customers-table';
import { getCustomers, type CustomerRow } from './queries';

export const dynamic = 'force-dynamic';

export default async function CustomersPage() {
  let customers: CustomerRow[] = [];
  let error: string | null = null;
  try {
    customers = await getCustomers();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        title="Müşteriler"
        description="Sipariş/atama geçmişi, değişim oranı ve etiketler — ara, filtrele, sırala."
      />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <CustomersTable customers={customers} />
      )}
    </div>
  );
}
