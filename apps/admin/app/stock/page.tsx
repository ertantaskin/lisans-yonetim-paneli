import Link from 'next/link';
import { ArrowLeft, Boxes, FolderTree, KeyRound, PackagePlus, Search } from 'lucide-react';
import { apiGet } from '../../lib/api';
import { EmptyState, PageHeader } from '../../components/ui/page-header';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { HowItWorks } from '../../components/ui/help-note';
import { ProductsTable, type ProductTableRow } from '../../components/products-table';
import { ProductCreateSheet } from '../../components/product-create-sheet';
import { CategoryGrid } from '../../components/category-grid';
import { LicenseItemsTable } from '../../components/inventory/license-items-table';
import { getCategories } from '../categories/queries';
import { UNCATEGORIZED, type CategoryRow } from '../../lib/categories';
import { includesTr } from '../../lib/utils';

export const dynamic = 'force-dynamic';

/**
 * Stok & Ürünler — KATEGORİ → ürün hiyerarşisi (kullanıcı geri bildirimi: "panel ürünleri
 * direkt görünüyor, karışıklığı gidermek için kategorize edelim; kart tarzı daha kullanışlı").
 *
 * Üç hâl, hepsi paylaşılabilir URL (müşteriler ekranıyla AYNI desen — tek gezinme dili):
 *   1. `/stock`                 → kategori kartları + akış rehberi
 *   2. `/stock?q=<terim>`       → tüm ürünlerde arama (hiyerarşiyi atlar)
 *   3. `/stock?category=<id>`   → o kategorinin ürün tablosu ('none' = kategorisiz)
 *
 * "Son Eklenen Lisanslar" YALNIZ giriş ekranında durur: kategori içindeyken o bölüm
 * bağlamsız (tüm ürünlerden) veri gösterir ve seçili kategoriyle çelişirdi.
 */
export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; q?: string }>;
}) {
  const { category, q } = await searchParams;
  const term = q?.trim() ?? '';
  const mode: 'search' | 'category' | 'categories' = term
    ? 'search'
    : category
      ? 'category'
      : 'categories';

  let products: ProductTableRow[] = [];
  let categories: CategoryRow[] = [];
  let error: string | null = null;
  let categoriesUnavailable = false;
  try {
    // Ürün listesi HER hâlde çekilir: arama ve kategori süzgeci aynı listeden türetilir
    // (ürün sayısı panel ölçeğinde küçüktür — kategori başına ayrı uç açmak yerine tek çekim).
    products = await apiGet<ProductTableRow[]>('/v1/admin/products');
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }
  if (!error) {
    try {
      // HER hâlde çekilir: kartlar için sayaçlar, tablo/düzenleme paneli için seçenek listesi
      // (ürünü başka kategoriye taşımak satır içindeki "Düzenle"den de yapılabilmeli).
      categories = await getCategories();
    } catch {
      // API eski sürümdeyse (dağıtım sapması) ekran kırılmaz: düz ürün tablosuna düşer.
      categoriesUnavailable = true;
    }
  }

  // Formlarda seçilebilir gerçek kategoriler ("Kategorisiz" sanal kova değildir).
  const selectableCategories = categories
    .filter((c) => c.id !== UNCATEGORIZED)
    .map((c) => ({ id: c.id, name: c.name }));

  // Kategori ADI önce kategori listesinden, olmazsa üründen okunur — BOŞ bir kategoriye
  // girildiğinde de başlık doğru adı yazsın (ürün listesi boş olduğu için ondan çözülemez).
  const activeCategoryName =
    category === UNCATEGORIZED
      ? 'Kategorisiz'
      : (categories.find((c) => c.id === category)?.name ??
        products.find((p) => p.categoryId === category)?.categoryName ??
        null);

  const visible =
    mode === 'search'
      ? products.filter(
          (p) =>
            includesTr(p.name, term) ||
            includesTr(p.sku, term) ||
            includesTr(p.categoryName ?? '', term),
        )
      : mode === 'category'
        ? products.filter((p) =>
            category === UNCATEGORIZED ? !p.categoryId : p.categoryId === category,
          )
        : products;

  const description =
    mode === 'search'
      ? `“${term}” için tüm kategorilerde arandı.`
      : mode === 'category'
        ? `${activeCategoryName ?? 'Seçili kategori'} kategorisindeki ürünler. Stok girişi ve site eşlemeleri ürün detayındadır.`
        : 'Ürünleriniz kategorilere göre gruplanır. Kategoriye girin ya da doğrudan arayın.';

  return (
    <div className="space-y-5">
      <PageHeader icon={Boxes} title="Stok & Ürünler" description={description}>
        <Button asChild variant="outline">
          <Link href="/categories">
            <FolderTree className="size-4" /> Kategoriler
          </Link>
        </Button>
        <Button asChild>
          <Link href="/stock/import">
            <PackagePlus className="size-4" /> Stok Girişi
          </Link>
        </Button>
        <ProductCreateSheet categories={selectableCategories} />
      </PageHeader>

      {/* Rehber şerit: "panel ürünü ekleniyor, sonra mağaza ürünüyle eşleşiyor" akışı
          ekranın kendisinde anlatılır (kullanıcı isteği) — yalnız giriş seviyesinde. */}
      {mode === 'categories' && (
        <HowItWorks
          compact
          steps={[
            {
              title: '1. Panel ürünü',
              text: (
                <>
                  Sattığınız şeyi panelde tanımlarsınız (Windows 11 Pro, Office 365 hesabı…).
                  Kategori seçmek listeyi düzenli tutar.
                </>
              ),
            },
            {
              title: '2. Stok girişi',
              text: (
                <>
                  Anahtar/hesap kayıtlarını <Link href="/stock/import" className="underline underline-offset-2">Stok Girişi</Link>{' '}
                  ekranından yapıştırırsınız; tedarikçi ve parti bilgisi aynı ekranda girilir.
                </>
              ),
            },
            {
              title: '3. Mağaza eşlemesi',
              text: (
                <>
                  Panel ürününü mağazadaki ürüne{' '}
                  <Link href="/mappings" className="underline underline-offset-2">bağlarsınız</Link>.
                  Sipariş gelince teslimat bu bağ üzerinden otomatik yapılır; bağ yoksa satır bekler.
                </>
              ),
            },
          ]}
        />
      )}

      {/* Arama her hâlde üstte: hiyerarşi bir kısıt değil, varsayılan yol (müşteriler deseni). */}
      <form action="/stock" method="get" className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            name="q"
            defaultValue={term}
            placeholder="Tüm ürünlerde ara (ad, SKU, kategori)…"
            aria-label="Tüm ürünlerde ara"
            className="bg-muted/40 pl-8"
          />
        </div>
        <Button type="submit" variant="outline" size="sm">
          Ara
        </Button>
        {mode !== 'categories' && (
          <Button asChild variant="ghost" size="sm">
            <Link href="/stock">
              <ArrowLeft className="size-3.5" /> Tüm kategoriler
            </Link>
          </Button>
        )}
      </form>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>API&apos;ye ulaşılamadı: {error}</AlertDescription>
        </Alert>
      )}

      {!error && mode === 'categories' && !categoriesUnavailable ? (
        categories.length === 0 ? (
          <EmptyState
            icon={FolderTree}
            title="Henüz kategori yok"
            description="Ürünler kategorilere göre gruplanır. İlk kategoriyi açın (ör. “Windows lisansları”), sonra ürünleri içine koyun. Kategorisiz ürünler de burada ayrı bir kartta görünür."
          >
            <Button asChild size="sm">
              <Link href="/categories">
                <FolderTree className="size-3.5" /> Kategori oluştur
              </Link>
            </Button>
          </EmptyState>
        ) : (
          <CategoryGrid categories={categories} />
        )
      ) : !error ? (
        <>
          {categoriesUnavailable && (
            <Alert variant="muted">
              <AlertDescription>
                Kategori görünümü şu an kullanılamıyor (API sürümü) — tüm ürünler düz listede.
              </AlertDescription>
            </Alert>
          )}
          {mode === 'search' && visible.length === 0 ? (
            <EmptyState
              icon={Search}
              title={`“${term}” ile eşleşen ürün yok`}
              description="Ürün adı, SKU ya da kategori adının bir parçasıyla arayın."
            >
              <Button asChild variant="outline" size="sm">
                <Link href="/stock">
                  <ArrowLeft className="size-3.5" /> Kategori listesi
                </Link>
              </Button>
            </EmptyState>
          ) : (
            <ProductsTable products={visible} categories={selectableCategories} />
          )}
        </>
      ) : null}

      {/* Ürün fark etmeksizin son eklenen lisans/hesap kalemleri — YALNIZ giriş ekranında. */}
      {mode === 'categories' && !error && (
        <Card>
          <CardHeader>
            <CardTitle icon={KeyRound}>Son Eklenen Lisanslar</CardTitle>
            <CardDescription>
              Tüm ürünlerden en son girilen lisans/hesap kalemleri — arayın, duruma göre süzün,
              teslim edilenlerin siparişine gidin.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LicenseItemsTable showProductColumn defaultPageSize={10} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
