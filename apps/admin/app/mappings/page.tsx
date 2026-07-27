import { Link2 } from 'lucide-react';
import { apiGet, type UnmappedRow, type ProductRow } from '../../lib/api';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { UnmappedTable } from '../../components/unmapped-table';

export const dynamic = 'force-dynamic';

/**
 * Ürün Eşleştirme (§3) — gerçek siparişlerde gelmiş ama panelde bir ürüne eşlenmemiş mağaza
 * ürünlerini listeler ve TEK TIKLA eşlemeyi sağlar. Mağaza ürün ID'si gerçek sipariş verisinden
 * ön-dolar → operatör ID yazmaz (elle-ID typo riski yok). Panel ürünü + paket adedi seçilir;
 * aynı `createMappingAction` (app/stock/actions) ile eşleme oluşur.
 */
export default async function MappingsPage() {
  let rows: UnmappedRow[] = [];
  let products: ProductRow[] = [];
  let error: string | null = null;
  try {
    [rows, products] = await Promise.all([
      apiGet<UnmappedRow[]>('/v1/admin/mappings/unmapped'),
      apiGet<ProductRow[]>('/v1/admin/products'),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        icon={Link2}
        title="Ürün Eşleştirme"
        description="Gerçek siparişlerde gelmiş ama panelde bir ürüne eşlenmemiş mağaza ürünleri. Tek tıkla eşleyin — mağaza ürün ID'si sipariş verisinden gelir, elle yazmazsınız (typo riski yok)."
      />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API&apos;ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <UnmappedTable rows={rows} products={products} />
      )}
    </div>
  );
}
