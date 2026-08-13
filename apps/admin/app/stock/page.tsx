import Link from 'next/link';
import { Boxes, KeyRound, PackagePlus } from 'lucide-react';
import { apiGet } from '../../lib/api';
import { PageHeader } from '../../components/ui/page-header';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { ProductsTable, type ProductTableRow } from '../../components/products-table';
import { ProductCreateSheet } from '../../components/product-create-sheet';
import { LicenseItemsTable } from '../../components/inventory/license-items-table';

export const dynamic = 'force-dynamic';

/**
 * Stok & Ürünler — ürün-merkezli sadeleştirilmiş liste. Üstte ürün tablosu + "Stok Girişi"
 * (ayrı ekran) + "Yeni Ürün" (Sheet), altta ürün-bağımsız "Son Eklenen Lisanslar" envanteri.
 *
 * Stok girişi artık kendi ekranındadır (`/stock/import`): eskiden yalnız ürün DETAYINDA
 * bulunabiliyordu, yani operatörün en sık yaptığı işe ulaşmak için önce doğru ürünü bulup
 * detayına inmesi gerekiyordu. Site eşlemeleri ve ürün düzenleme bağlamsal kaldığı için
 * hâlâ ürün detayındadır → bu ekran çok üründe bile taranabilir kalır.
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
        description="Ürünleri yönetin ve stok girin. Yeni key/hesap eklemek için 'Stok Girişi' ekranını kullanın; site eşlemeleri ile ürün düzenleme her ürünün detay sayfasındadır."
      >
        {/* Birincil iş: stok girmek (en sık yapılan işlem). Ürün seçimi hedef ekranda yapılır. */}
        <Button asChild>
          <Link href="/stock/import">
            <PackagePlus className="size-4" /> Stok Girişi
          </Link>
        </Button>
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
