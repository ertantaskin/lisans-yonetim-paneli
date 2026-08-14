import Link from 'next/link';
import { Boxes, FolderTree } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { HowItWorks } from '../../components/ui/help-note';
import { CategoriesManager } from '../../components/categories-manager';
import { getCategories } from './queries';
import type { CategoryRow } from '../../lib/categories';

export const dynamic = 'force-dynamic';

/**
 * Kategoriler (§17) — ürünleri gruplayan TEK ad kaynağı. Ürün formunda kategori serbest
 * yazılamaz, yalnız buradaki listeden seçilir (kullanıcı kararı: ikiz kategori olmasın,
 * ad değişince her yerde değişsin).
 *
 * Kategori bir ETİKET değil, bir KOVA: bir ürün en fazla bir kategoriye girer. Böylece
 * "kaç ürün" sayaçları çakışmaz ve Stok & Ürünler ekranı tek seviyeli açılır.
 */
export default async function CategoriesPage() {
  let categories: CategoryRow[] = [];
  let error: string | null = null;
  try {
    categories = await getCategories();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={FolderTree}
        title="Kategoriler"
        description="Ürünleri gruplayın: Stok & Ürünler ekranı bu kategorilere göre açılır. Bir ürün en fazla bir kategoriye girer; kategorisiz ürünler ayrı bir kartta toplanır."
      >
        <Button asChild variant="outline">
          <Link href="/stock">
            <Boxes className="size-4" /> Stok & Ürünler
          </Link>
        </Button>
      </PageHeader>

      <HowItWorks
        compact
        steps={[
          {
            title: 'Kategori aç',
            text: 'Sattığınız işlere göre gruplayın: Windows lisansları, Office lisansları, oyun hesapları…',
          },
          {
            title: 'Ürünü kategoriye koy',
            text: 'Ürün eklerken/düzenlerken kategori seçilir. Boş bırakılırsa ürün “Kategorisiz” kartında durur — kaybolmaz.',
          },
          {
            title: 'Stok ekranı gruplanır',
            text: 'Stok & Ürünler artık kategori kartlarıyla açılır; kartın içinde o grubun ürünleri listelenir.',
          },
        ]}
      />

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>API&apos;ye ulaşılamadı: {error}</AlertDescription>
        </Alert>
      ) : (
        <CategoriesManager categories={categories} />
      )}
    </div>
  );
}
