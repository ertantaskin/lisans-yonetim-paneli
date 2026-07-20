import { apiGet, type OrderRow } from '../../lib/api';
import { PageHeader } from '../../components/ui';
import { Card } from '../../components/ui/card';
import { OrdersTable } from '../../components/orders-table';

export const dynamic = 'force-dynamic';

export default async function OrdersPage() {
  let orders: OrderRow[] = [];
  let error: string | null = null;
  try {
    orders = await apiGet<OrderRow[]>('/v1/admin/orders');
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader title="Siparişler" desc="Tüm siparişler — ara, filtrele, sırala." />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <OrdersTable orders={orders} />
      )}
    </div>
  );
}
