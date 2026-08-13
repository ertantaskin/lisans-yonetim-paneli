import Link from 'next/link';
import { PackagePlus } from 'lucide-react';
import { apiGet, type ProductRow } from '../../../lib/api';
import { PageHeader } from '../../../components/ui/page-header';
import { Alert, AlertDescription } from '../../../components/ui/alert';
import { Button } from '../../../components/ui/button';
import { fetchProductBatchesAction, type ProductBatchOption } from '../actions';
import { ImportWorkbench, type SupplierPick } from './import-workbench';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stok Girişi (§12) — anahtar/hesap girmenin TEK ekranı.
 *
 * Derin bağlantılar:
 *  · `?product=<uuid>` — ürün detayından "Stok gir" (ürün ön-seçili gelir).
 *  · `?batch=<uuid>`   — /batches "Bu partiye stok gir" (mevcut parti modu seçili gelir).
 *
 * Ürünün partileri BURADA (yalnız derin bağlantı varsa) ön-yüklenir; ürün değişince istemci
 * `fetchProductBatchesAction` ile yeniden çeker. Tüm partileri önden yüklemeyiz: `/v1/admin/batches`
 * ürün filtresi kabul etmez ve iki tam GROUP BY yapar.
 */
export default async function StockImportPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string; batch?: string }>;
}) {
  const { product, batch } = await searchParams;
  const productId = product && UUID_RE.test(product) ? product : '';
  const batchId = batch && UUID_RE.test(batch) ? batch : '';

  let products: ProductRow[] = [];
  let suppliers: SupplierPick[] = [];
  let error: string | null = null;
  try {
    [products, suppliers] = await Promise.all([
      apiGet<ProductRow[]>('/v1/admin/products'),
      // Tedarikçi listesi küçük ve "yeni parti" modunda anında gerekiyor → sayfayla birlikte gelir.
      apiGet<SupplierPick[]>('/v1/admin/suppliers'),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  // Parti ön-yüklemesi AYRI try/catch: tedarik ucu geçici hata verse bile stok girişi çalışsın.
  let batches: ProductBatchOption[] = [];
  let inactiveBatchCount = 0;
  if (productId) {
    const r = await fetchProductBatchesAction(productId);
    if (r.ok) {
      batches = r.batches ?? [];
      inactiveBatchCount = r.inactiveCount ?? 0;
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={PackagePlus}
        title="Stok Girişi"
        description="Anahtar/hesap girin, isterseniz aynı adımda tedarik partisini açın. Girmeden önce kuru çalıştırmayla doğrulayabilirsiniz."
      >
        <Button asChild variant="outline">
          <Link href="/stock">Stok &amp; Ürünler</Link>
        </Button>
      </PageHeader>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>API&apos;ye ulaşılamadı: {error}</AlertDescription>
        </Alert>
      )}

      {!error && products.length === 0 ? (
        <Alert variant="warning">
          <AlertDescription>
            Henüz ürün yok. Stok girebilmek için önce{' '}
            <Link href="/stock" className="underline underline-offset-4">
              Stok &amp; Ürünler
            </Link>{' '}
            ekranından bir ürün oluşturun.
          </AlertDescription>
        </Alert>
      ) : (
        <ImportWorkbench
          products={products}
          suppliers={suppliers}
          initialProductId={productId}
          initialBatchId={batchId}
          initialBatches={batches}
          initialInactiveBatchCount={inactiveBatchCount}
        />
      )}
    </div>
  );
}
