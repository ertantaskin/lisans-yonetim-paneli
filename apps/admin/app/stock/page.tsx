import { apiGet, type ProductRow, type SiteRow } from '../../lib/api';
import { Card, PageHeader, Empty } from '../../components/ui';
import { ImportStockForm } from '../../components/import-stock-form';
import { ProductCreateForm } from '../../components/product-create-form';
import { createMappingAction } from './actions';

/** Ürün tipi rozeti: kind + (multi ise) kapasite bilgisi. */
function typeLabel(p: ProductRow): string {
  const parts = [p.kind];
  if (p.usageMode === 'multi') parts.push(`MAK×${p.maxUses ?? '?'}`);
  if (p.validityDays) parts.push(`${p.validityDays}g`);
  return parts.join(' · ');
}

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
    <div className="max-w-4xl">
      <PageHeader title="Stok & Ürünler" desc="Ürünler, anlık stok ve şifreli key import." />

      {error && (
        <Card className="mb-5">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      )}

      {/* Ürünler + stok */}
      <Card className="mb-5">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Ürünler</h2>
        {products.length === 0 ? (
          <Empty>Ürün yok.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Ürün</th>
                  <th className="px-3 py-2 font-medium">SKU</th>
                  <th className="px-3 py-2 font-medium">Tip</th>
                  <th className="px-3 py-2 font-medium">Politika</th>
                  <th className="px-3 py-2 font-medium">Stok</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id} className="border-b border-border">
                    <td className="px-3 py-2.5 font-medium text-foreground">{p.name}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-foreground/60">{p.sku}</td>
                    <td className="px-3 py-2.5 text-xs text-foreground/70">{typeLabel(p)}</td>
                    <td className="px-3 py-2.5 text-foreground/70">{p.fulfillmentPolicy}</td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`tabular-nums font-medium ${
                          p.availableStock > 0 ? 'text-success' : 'text-destructive'
                        }`}
                        title={p.usageMode === 'multi' ? 'kalan kapasite (Σ max-kullanım − kullanılan)' : 'available satır'}
                      >
                        {p.availableStock}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Stok import */}
      <Card className="mb-5">
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
  );
}
