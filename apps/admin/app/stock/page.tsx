import { apiGet, type ProductRow, type SiteRow } from '../../lib/api';
import { Card, PageHeader } from '../../components/ui';
import { ImportStockForm } from '../../components/import-stock-form';
import { ProductCreateForm } from '../../components/product-create-form';
import { ProductsTable } from '../../components/products-table';
import { createMappingAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function StockPage() {
  let products: ProductRow[] = [];
  let sites: SiteRow[] = [];
  let error: string | null = null;
  try {
    [products, sites] = await Promise.all([
      apiGet<ProductRow[]>('/v1/admin/products'),
      apiGet<SiteRow[]>('/v1/admin/sites'),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  const inputCls =
    'rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-ring';

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
          <ImportStockForm products={products} />
        </Card>

        <div className="grid gap-5 md:grid-cols-2">
          {/* Ürün oluştur */}
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-foreground">Ürün Oluştur</h2>
            <ProductCreateForm />
          </Card>

          {/* Eşleme */}
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-foreground">Site-Ürün Eşleme</h2>
            <form action={createMappingAction} className="space-y-3 text-sm">
              <select name="siteId" required className={`w-full ${inputCls}`}>
                <option value="">— site —</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.domain}
                  </option>
                ))}
              </select>
              <select name="productId" required className={`w-full ${inputCls}`}>
                <option value="">— ürün —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input
                name="remoteProductId"
                placeholder="Woo ürün ID (ör. 555)"
                required
                className={`w-full ${inputCls}`}
              />
              <button
                type="submit"
                className="rounded-md bg-primary px-4 py-1.5 font-medium text-primary-foreground hover:opacity-90"
              >
                Eşle
              </button>
            </form>
          </Card>
        </div>
      </div>
    </div>
  );
}
