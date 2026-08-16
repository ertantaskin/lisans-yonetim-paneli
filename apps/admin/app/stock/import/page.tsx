import Link from 'next/link';
import { PackagePlus } from 'lucide-react';
import { apiGet, type ProductRow } from '../../../lib/api';
import { PageHeader } from '../../../components/ui/page-header';
import { Alert, AlertDescription } from '../../../components/ui/alert';
import { Button } from '../../../components/ui/button';
import { fetchProductBatchesAction, type ProductBatchOption } from '../actions';
import { ImportWorkbench, type SupplierPick } from './import-workbench';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stok Girişi (§12) — anahtar/hesap girmenin TEK ekranı.
 *
 * Derin bağlantılar:
 *  · `?product=<uuid>` — ürün detayından "Stok gir" (ürün ön-seçili gelir).
 *  · `?batch=<uuid>`   — /batches "Bu partiye stok gir" (mevcut parti modu seçili gelir).
 *
 * Ürünün partileri BURADA (yalnız derin bağlantı varsa) ön-yüklenir; ürün değişince istemci
 * `fetchProductBatchesAction` ile yeniden çeker — o da süzgeci SUNUCUYA taşır (`?productId=`),
 * böylece ürünün partisi global "en yeni N" penceresinin dışında kalıp kaybolmaz. Tüm partileri
 * önden yüklemeyiz: `/v1/admin/batches` iki tam GROUP BY yapar.
 */
export default async function StockImportPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string; batch?: string }>;
}) {
  const { product, batch } = await searchParams;
  const productId = product && UUID_RE.test(product) ? product : '';
  const batchId = batch && UUID_RE.test(batch) ? batch : '';

  let products: ProductRow[] = [];
  let suppliers: SupplierPick[] = [];
  let error: string | null = null;
  /** Tedarikçi listesi gelmedi mi — stok girişi yapılabilir, yalnız "yeni parti" modu eksik kalır. */
  let suppliersUnavailable = false;
  try {
    /*
      YARDIMCI VERİ SAYFAYI DÜŞÜRMEZ (denetim D2): tedarikçi listesi yalnız İSTEĞE BAĞLI
      "tedarik bilgisi / yeni parti" bölümünü doldurur. Çıplak bırakıldığında tedarik ucunun
      geçici hatası stok girişini TAMAMEN engelliyordu — oysa anahtar girmek bu panelin en
      kritik işi ve partisiz giriş zaten meşru bir mod. Ürün listesi ise gerçekten zorunlu
      (ürün seçilmeden hiçbir şey girilemez) → o çıplak kalır ve hata kartına düşer.
      Hata SESSİZCE yutulmaz: aşağıda görünür uyarıya dönüşür (tedarikçi kutusu boş görünüp
      operatöre "hiç tedarikçim yok" dedirtmesin — yanlışlıkla yeni tedarikçi açardı).
    */
    [products, suppliers] = await Promise.all([
      apiGet<ProductRow[]>('/v1/admin/products'),
      // Tedarikçi listesi küçük ve "yeni parti" modunda anında gerekiyor → sayfayla birlikte gelir.
      apiGet<SupplierPick[]>('/v1/admin/suppliers').catch(() => {
        suppliersUnavailable = true;
        return [] as SupplierPick[];
      }),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  // Parti ön-yüklemesi AYRI try/catch: tedarik ucu geçici hata verse bile stok girişi çalışsın.
  let batches: ProductBatchOption[] = [];
  let inactiveBatchCount = 0;
  let batchListTruncated = false;
  if (productId) {
    const r = await fetchProductBatchesAction(productId);
    if (r.ok) {
      batches = r.batches ?? [];
      inactiveBatchCount = r.inactiveCount ?? 0;
      batchListTruncated = r.listTruncated === true;
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={PackagePlus}
        title="Stok Girişi"
        description="Anahtar/hesap girin, isterseniz aynı adımda tedarik partisini açın. Girmeden önce kuru çalıştırmayla doğrulayabilirsiniz."
      >
        <Button asChild variant="outline">
          <Link href="/stock">Stok &amp; Ürünler</Link>
        </Button>
      </PageHeader>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>API&apos;ye ulaşılamadı: {error}</AlertDescription>
        </Alert>
      )}

      {!error && suppliersUnavailable && (
        <Alert variant="warning">
          <AlertDescription>
            Tedarikçi listesi alınamadı — anahtar/hesap girişi normal çalışır, ancak “tedarik
            bilgisi” bölümünde mevcut tedarikçileri seçemezsiniz. Listeniz boş DEĞİL, yalnız
            şu an okunamıyor; yeni tedarikçi açmadan önce sayfayı yenileyin.
          </AlertDescription>
        </Alert>
      )}

      {!error && products.length === 0 ? (
        <Alert variant="warning">
          <AlertDescription>
            Henüz ürün yok. Stok girebilmek için önce{' '}
            <Link href="/stock" className="underline underline-offset-4">
              Stok &amp; Ürünler
            </Link>{' '}
            ekranından bir ürün oluşturun.
          </AlertDescription>
        </Alert>
      ) : (
        <ImportWorkbench
          products={products}
          suppliers={suppliers}
          initialProductId={productId}
          initialBatchId={batchId}
          initialBatches={batches}
          initialInactiveBatchCount={inactiveBatchCount}
          initialBatchListTruncated={batchListTruncated}
        />
      )}
    </div>
  );
}
