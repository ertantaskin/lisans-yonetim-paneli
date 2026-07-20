import { apiGet, type ProductRow, type SiteRow } from '../../lib/api';
import { Card, PageHeader } from '../../components/ui';
import { ImportStockForm } from '../../components/import-stock-form';
import { ProductCreateForm } from '../../components/product-create-form';
import { ProductsTable } from '../../components/products-table';
import { MappingsManager, type MappingRow } from '../../components/mappings-manager';

export const dynamic = 'force-dynamic';

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ batchId?: string }>;
}) {
  const { batchId } = await searchParams;

  let products: ProductRow[] = [];
  let sites: SiteRow[] = [];
  let mappings: MappingRow[] = [];
  let error: string | null = null;
  try {
    [products, sites, mappings] = await Promise.all([
      apiGet<ProductRow[]>('/v1/admin/products'),
      apiGet<SiteRow[]>('/v1/admin/sites'),
      apiGet<MappingRow[]>('/v1/admin/mappings'),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader title="Stok & Ürünler" desc="Ürünler, anlık stok ve şifreli key import." />

      {error && (
        <Card className="mb-5">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      )}

      {/* Ürünler + stok — DataTable */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Ürünler</h2>
        <ProductsTable products={products} />
      </section>

      <div className="max-w-4xl space-y-5">
        {/* Stok import */}
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-foreground">Stok Import (Onayla ve Dağıt)</h2>
          <ImportStockForm products={products} defaultBatchId={batchId} />
        </Card>

        {/* Ürün oluştur */}
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-foreground">Ürün Oluştur</h2>
          <ProductCreateForm />
        </Card>

        {/* Site-Ürün Eşleme */}
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-foreground">Site-Ürün Eşleme</h2>
          <MappingsManager sites={sites} products={products} mappings={mappings} />
        </Card>
      </div>
    </div>
  );
}
