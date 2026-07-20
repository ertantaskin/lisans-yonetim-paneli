import { PageHeader, Card } from '@/components/ui';
import { CreatePOForm } from '@/components/create-po-form';
import { PurchaseOrdersTable } from '@/components/purchase-orders-table';
import { getPurchaseOrders, getPurchaseOrderFormData, type PurchaseOrderRow } from './queries';

export const dynamic = 'force-dynamic';

export default async function PurchaseOrdersPage() {
  let orders: PurchaseOrderRow[] = [];
  let suppliers: Awaited<ReturnType<typeof getPurchaseOrderFormData>>['suppliers'] = [];
  let products: Awaited<ReturnType<typeof getPurchaseOrderFormData>>['products'] = [];
  let error: string | null = null;
  try {
    const [list, form] = await Promise.all([getPurchaseOrders(), getPurchaseOrderFormData()]);
    orders = list;
    suppliers = form.suppliers;
    products = form.products;
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader title="Satın Alma Emirleri" desc="Tedarikçilere verilen emirler — teslim aldıkça parti oluşur (§12)." />

      <Card className="mb-5 max-w-3xl">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Yeni Emir</h2>
        <CreatePOForm suppliers={suppliers} products={products} />
      </Card>

      {error ? (
        <Card>
          <p className="text-sm text-destructive">API&apos;ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <PurchaseOrdersTable orders={orders} />
      )}
    </div>
  );
}
