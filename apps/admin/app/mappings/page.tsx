import { Link2, Store, PackageSearch } from 'lucide-react';
import {
  apiGet,
  type UnmappedRow,
  type ProductRow,
  type CatalogSummaryRow,
  type CatalogRow,
} from '../../lib/api';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { UnmappedTable } from '../../components/unmapped-table';
import { CatalogTable } from '../../components/catalog-table';

export const dynamic = 'force-dynamic';

/**
 * Ürün Eşleştirme (§3) — iki bölüm:
 *  1. **Site Kataloğu (proaktif):** operatör bir site seçer → o mağazanın senkronlanmış TÜM ürünlerini
 *     ADIYLA görür ve sipariş beklemeden panel ürününe eşler.
 *  2. **Eşlenmemiş Gelen Ürünler (reaktif):** gerçek siparişlerde gelmiş ama panelde bir ürüne eşlenmemiş
 *     mağaza ürünleri.
 * Her iki bölümde de mağaza ürün ID'si katalog/sipariş verisinden gelir → operatör ID YAZMAZ (typo yok);
 * aynı `createMappingAction` (app/stock/actions) ile eşleme oluşur.
 */
export default async function MappingsPage({
  searchParams,
}: {
  searchParams: Promise<{ site?: string }>;
}) {
  const { site } = await searchParams;

  let summary: CatalogSummaryRow[] = [];
  let rows: UnmappedRow[] = [];
  let products: ProductRow[] = [];
  let catalog: CatalogRow[] = [];
  let error: string | null = null;
  try {
    [summary, rows, products] = await Promise.all([
      apiGet<CatalogSummaryRow[]>('/v1/admin/catalog/summary'),
      apiGet<UnmappedRow[]>('/v1/admin/mappings/unmapped'),
      apiGet<ProductRow[]>('/v1/admin/products'),
    ]);
    if (site) {
      catalog = await apiGet<CatalogRow[]>(`/v1/admin/catalog?siteId=${encodeURIComponent(site)}`);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        icon={Link2}
        title="Ürün Eşleştirme"
        description="Mağaza ürünlerini panel ürünlerine eşleyin. Site kataloğundan sipariş beklemeden proaktif eşleyin ya da siparişte gelmiş eşlenmemiş ürünleri tek tıkla eşleyin — mağaza ürün ID'si veriden gelir, elle yazmazsınız (typo riski yok)."
      />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API&apos;ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <div className="space-y-10">
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Store className="size-4 text-muted-foreground" aria-hidden />
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                Site Kataloğu (proaktif eşleme)
              </h2>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Bir mağaza seçin; o sitenin senkronlanmış tüm ürünlerini ADIYLA görün ve sipariş
              beklemeden panel ürününe eşleyin.
            </p>
            <CatalogTable sites={summary} siteId={site} rows={catalog} products={products} />
          </section>

          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <PackageSearch className="size-4 text-muted-foreground" aria-hidden />
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                Eşlenmemiş Gelen Ürünler
              </h2>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Gerçek siparişlerde gelmiş ama panelde bir ürüne eşlenmemiş mağaza ürünleri. Tek tıkla
              eşleyin.
            </p>
            <UnmappedTable rows={rows} products={products} />
          </section>
        </div>
      )}
    </div>
  );
}
