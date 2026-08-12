import { ShoppingCart } from 'lucide-react';
import { apiGet } from '../../lib/api';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { OrdersTable, type OrdersTableRow } from '../../components/orders-table';
import { SavedViewsMenu } from '../../components/saved-views-menu';

export const dynamic = 'force-dynamic';

export default async function OrdersPage() {
  // §8 held bayrağını da taşıyan genişletilmiş satır tipi (tablo bileşeninde tanımlı) —
  // "İncelemede" siparişler listede ham 'Bekliyor' görünmesin diye.
  let orders: OrdersTableRow[] = [];
  let error: string | null = null;
  try {
    orders = await apiGet<OrdersTableRow[]>('/v1/admin/orders');
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      {/* Açıklama DÜRÜST: liste sunucuda en yeni 200 kayıtla sınırlı (tablo üstünde de bant). */}
      <PageHeader
        icon={ShoppingCart}
        title="Siparişler"
        description="En yeni siparişler — ara, filtrele, sırala. Arama ve süzgeçler yüklenen pencere üzerinde çalışır."
      >
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
