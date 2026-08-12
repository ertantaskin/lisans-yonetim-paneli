import { Boxes, KeyRound } from 'lucide-react';
import { apiGet } from '../../lib/api';
import { PageHeader } from '../../components/ui/page-header';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { ProductsTable, type ProductTableRow } from '../../components/products-table';
import { ProductCreateSheet } from '../../components/product-create-sheet';
import { LicenseItemsTable } from '../../components/inventory/license-items-table';

export const dynamic = 'force-dynamic';

/**
 * Stok & Ürünler — ürün-merkezli sadeleştirilmiş liste. Üstte ürün tablosu + "Yeni Ürün" (Sheet),
 * altta ürün-bağımsız "Son Eklenen Lisanslar" envanteri. Key import, site eşlemeleri ve düzenleme
 * her ürünün DETAY sayfasında (bağlamsal) → bu ekran çok üründe bile taranabilir kalır.
 */
export default async function StockPage() {
  // ProductTableRow = ProductRow + eşleme boyutu (mappedSites/mappingCount). Alanlar
  // opsiyonel → eski api imajında ekran kırılmaz, yalnız "Satıldığı siteler" kolonu '—' olur.
  let products: ProductTableRow[] = [];
  let error: string | null = null;
  try {
    products = await apiGet<ProductTableRow[]>('/v1/admin/products');
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Boxes}
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

      {/* Ürün fark etmeksizin son eklenen lisans/hesap kalemleri — tek bölüm, ek kart yok
          (ekranın sadeliği korunur; ürün-özel işler yine ürün detayında). */}
      <Card>
        <CardHeader>
          <CardTitle icon={KeyRound}>Son Eklenen Lisanslar</CardTitle>
          <CardDescription>
            Tüm ürünlerden en son girilen lisans/hesap kalemleri — arayın, duruma göre süzün,
            teslim edilenlerin siparişine gidin.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LicenseItemsTable showProductColumn />
        </CardContent>
      </Card>
    </div>
  );
}
