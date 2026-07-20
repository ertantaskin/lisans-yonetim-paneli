import { apiGet, type ProductRow, type SiteRow } from '../../lib/api';
import { Card, PageHeader, StatusPill, Empty } from '../../components/ui';
import { ImportStockForm } from '../../components/import-stock-form';
import { createProductAction, createMappingAction } from './actions';

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
    'rounded-md border border-ink/15 bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent';

  return (
    <div className="max-w-4xl">
      <PageHeader title="Stok & Ürünler" desc="Ürünler, anlık stok ve şifreli key import." />

      {error && (
        <Card className="mb-5">
          <p className="text-sm text-danger">API'ye ulaşılamadı: {error}</p>
        </Card>
      )}

      {/* Ürünler + stok */}
      <Card className="mb-5">
        <h2 className="mb-3 text-sm font-semibold text-ink">Ürünler</h2>
        {products.length === 0 ? (
          <Empty>Ürün yok.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink/10 text-left text-xs uppercase text-ink/50">
                  <th className="px-3 py-2 font-medium">Ürün</th>
                  <th className="px-3 py-2 font-medium">SKU</th>
                  <th className="px-3 py-2 font-medium">Politika</th>
                  <th className="px-3 py-2 font-medium">Stok</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id} className="border-b border-ink/5">
                    <td className="px-3 py-2.5 font-medium text-ink">{p.name}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-ink/60">{p.sku}</td>
                    <td className="px-3 py-2.5 text-ink/70">{p.fulfillmentPolicy}</td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`tabular-nums font-medium ${
                          p.availableStock > 0 ? 'text-success' : 'text-danger'
                        }`}
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
        <h2 className="mb-3 text-sm font-semibold text-ink">Stok Import (Onayla ve Dağıt)</h2>
        <ImportStockForm products={products} />
      </Card>

      <div className="grid gap-5 md:grid-cols-2">
        {/* Ürün oluştur */}
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">Ürün Oluştur</h2>
          <form action={createProductAction} className="space-y-3 text-sm">
            <input
              name="sku"
              placeholder="SKU (win11-pro)"
              required
              className={`w-full ${inputCls}`}
            />
            <input name="name" placeholder="Ürün adı" required className={`w-full ${inputCls}`} />
            <div className="flex gap-2">
              <select name="usageMode" className={inputCls}>
                <option value="single">tek kullanımlık</option>
                <option value="multi">çok kullanımlık</option>
              </select>
              <select name="fulfillmentPolicy" className={inputCls}>
                <option value="partial-auto">partial-auto</option>
                <option value="partial-approval">partial-approval</option>
                <option value="all-or-nothing">all-or-nothing</option>
              </select>
            </div>
            <button
              type="submit"
              className="rounded-md bg-accent px-4 py-1.5 font-medium text-white hover:opacity-90"
            >
              Oluştur
            </button>
          </form>
        </Card>

        {/* Eşleme */}
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">Site-Ürün Eşleme</h2>
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
              className="rounded-md bg-accent px-4 py-1.5 font-medium text-white hover:opacity-90"
            >
              Eşle
            </button>
          </form>
        </Card>
      </div>
    </div>
  );
}
