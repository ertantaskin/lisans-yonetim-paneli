import { ClipboardList } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { CreatePOSheet } from '@/components/create-po-sheet';
import { PurchaseOrdersTable } from '@/components/purchase-orders-table';
import { getPurchaseOrders, getPurchaseOrderFormData, type PurchaseOrderRow } from './queries';

export const dynamic = 'force-dynamic';

export default async function PurchaseOrdersPage() {
  let orders: PurchaseOrderRow[] = [];
  /** Sunucu tavanı aşıldı mı — aşıldıysa EN ESKİ emirler listede değildir (sessiz kırpma yasak). */
  let truncated = false;
  let suppliers: Awaited<ReturnType<typeof getPurchaseOrderFormData>>['suppliers'] = [];
  let products: Awaited<ReturnType<typeof getPurchaseOrderFormData>>['products'] = [];
  let error: string | null = null;
  try {
    const [list, form] = await Promise.all([getPurchaseOrders(), getPurchaseOrderFormData()]);
    orders = list.items;
    truncated = list.truncated;
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
        <>
          {/* Sunucu tavanı aşıldı → EN ESKİ emirler listede yok. Sessiz kırpma bu panelde
              bir kez "o kayıt yok" dedirtti; bayrak API'den ekrana kadar taşınır. */}
          {truncated && (
            <Alert variant="warning" className="mb-4">
              <ClipboardList />
              <div className="min-w-0 flex-1">
                <AlertTitle>Liste sunucuda kırpıldı</AlertTitle>
                <AlertDescription>
                  Yalnız en yeni emirler gösteriliyor; daha eskileri bu listede değil. Belirli bir
                  emri arıyorsanız tedarikçi detayından ya da ilgili partiden ulaşabilirsiniz.
                </AlertDescription>
              </div>
            </Alert>
          )}
          <PurchaseOrdersTable orders={orders} />
        </>
      )}
    </div>
  );
}
