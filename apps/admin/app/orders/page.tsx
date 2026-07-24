import { ShoppingCart } from 'lucide-react';
import { apiGet, type OrderRow } from '../../lib/api';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { OrdersTable } from '../../components/orders-table';
import { SavedViewsMenu } from '../../components/saved-views-menu';

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
      <PageHeader icon={ShoppingCart} title="Siparişler" description="Tüm siparişler — ara, filtrele, sırala.">
        <SavedViewsMenu page="orders" />
      </PageHeader>
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
