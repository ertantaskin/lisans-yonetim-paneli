import { ClipboardList, Plus } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardContent } from '@/components/ui/card';
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
      <PageHeader icon={ClipboardList} title="Satın Alma Emirleri" description="Tedarikçilere verilen emirler — teslim aldıkça parti oluşur (§12)." />

      <Card className="mb-5 max-w-3xl">
        <CardContent className="p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Plus className="size-4 text-muted-foreground" /> Yeni Emir
          </h2>
          <CreatePOForm suppliers={suppliers} products={products} />
        </CardContent>
      </Card>

      {error ? (
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-destructive">API&apos;ye ulaşılamadı: {error}</p>
          </CardContent>
        </Card>
      ) : (
        <PurchaseOrdersTable orders={orders} />
      )}
    </div>
  );
}
