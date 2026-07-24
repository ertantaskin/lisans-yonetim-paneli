import { apiGet, type ProductRow } from '../../lib/api';
import { PageHeader } from '../../components/ui/page-header';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { ProductsTable } from '../../components/products-table';
import { ProductCreateSheet } from '../../components/product-create-sheet';

export const dynamic = 'force-dynamic';

/**
 * Stok & Ürünler — ürün-merkezli sadeleştirilmiş liste. Yalnız ürün tablosu + "Yeni Ürün" (Sheet).
 * Key import, site eşlemeleri ve düzenleme her ürünün DETAY sayfasında (bağlamsal) → bu ekran
 * çok üründe bile taranabilir kalır (eski hepsi-üst-üste global formlar kaldırıldı).
 */
export default async function StockPage() {
  let products: ProductRow[] = [];
  let error: string | null = null;
  try {
    products = await apiGet<ProductRow[]>('/v1/admin/products');
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Stok & Ürünler"
        description="Ürünleri yönetin. Key import, site eşlemeleri ve düzenleme her ürünün detay sayfasında."
      >
        <ProductCreateSheet />
      </PageHeader>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>API&apos;ye ulaşılamadı: {error}</AlertDescription>
        </Alert>
      )}

      <ProductsTable products={products} />
    </div>
  );
}
