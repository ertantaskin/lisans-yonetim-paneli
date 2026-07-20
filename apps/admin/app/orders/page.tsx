import { apiGet, type OrderRow } from '../../lib/api';
import { Card, PageHeader } from '../../components/ui';
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
      <PageHeader title="Siparişler" desc="Tüm siparişler (en yeni önce)." />
      <Card>
        {error ? (
          <p className="text-sm text-danger">API'ye ulaşılamadı: {error}</p>
        ) : (
          <OrdersTable orders={orders} />
        )}
      </Card>
    </div>
  );
}
