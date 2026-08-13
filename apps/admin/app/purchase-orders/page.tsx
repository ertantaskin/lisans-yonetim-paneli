import { ClipboardList } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { CreatePOSheet } from '@/components/create-po-sheet';
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
    <div className="space-y-5">
      <PageHeader
        icon={ClipboardList}
        title="Satın Alma Emirleri"
        description="Önceden verdiğiniz tedarik emirleri: mal geldikçe (parça parça da olabilir) teslim alırsınız, her teslim alma bir parti oluşturur. Mal zaten elinizdeyse emir açmanız gerekmez — Stok Girişi'nde tedarikçi + maliyet girerseniz panel teslim alınmış emri ve partiyi kendisi açar ('Otomatik' rozetli satırlar)."
      >
        <CreatePOSheet suppliers={suppliers} products={products} />
      </PageHeader>

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
