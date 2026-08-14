import { Link2, Store, PackageSearch, Clock } from 'lucide-react';
import {
  apiGet,
  type ProductRow,
  type CatalogSummaryRow,
  type PendingLinesSummary,
} from '../../lib/api';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { UnmappedTable, type UnmappedRowView } from '../../components/unmapped-table';
import { CatalogTable, type CatalogRowView } from '../../components/catalog-table';
import { PendingLinesPanel } from '../../components/pending-lines-panel';
import { SavedViewsMenu } from '../../components/saved-views-menu';

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
  // ?site= yalnız geçerli UUID ise katalog çekilir. Combobox zaten yalnız geçerli UUID üretir;
  // bu guard elle-düzenlenmiş/bayat URL'in API'de 400'e (ParseUUIDPipe) düşmesini önler.
  const siteValid =
    !!site && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(site);

  let summary: CatalogSummaryRow[] = [];
  // UnmappedRowView = UnmappedRow + PASİF eşleme alanları (API zaten döndürüyor).
  let rows: UnmappedRowView[] = [];
  let products: ProductRow[] = [];
  // CatalogRowView = CatalogRow + varyasyon sunum bayrakları (API zaten döndürüyor).
  let catalog: CatalogRowView[] = [];
  let pending: PendingLinesSummary | null = null;
  let error: string | null = null;
  let catalogError: string | null = null;
  let pendingError: string | null = null;
  try {
    [summary, rows, products] = await Promise.all([
      apiGet<CatalogSummaryRow[]>('/v1/admin/catalog/summary'),
      apiGet<UnmappedRowView[]>('/v1/admin/mappings/unmapped'),
      apiGet<ProductRow[]>('/v1/admin/products'),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }
  // Bekleyen satır özeti AYRI try/catch: yeni uç geçici hata verse bile eşleme ekranı çalışsın.
  try {
    pending = await apiGet<PendingLinesSummary>('/v1/admin/pending-lines');
  } catch (e) {
    pendingError = e instanceof Error ? e.message : 'Bekleyen satır özeti alınamadı';
  }
  // Katalog fetch'i AYRI try/catch: tek bir bozuk ?site= (400) ya da geçici katalog hatası TÜM
  // sayfayı (site seçici + reaktif "Eşlenmemiş Gelen Ürünler" güvenlik ağı dâhil) boşaltmasın.
  if (siteValid) {
    try {
      catalog = await apiGet<CatalogRowView[]>(
        `/v1/admin/catalog?siteId=${encodeURIComponent(site!)}`,
      );
    } catch (e) {
      catalogError = e instanceof Error ? e.message : 'Katalog yüklenemedi';
    }
  }

  return (
    <div>
      <PageHeader
        icon={Link2}
        title="Ürün Eşleştirme"
        description="Mağaza ürünlerini panel ürünlerine eşleyin. Site kataloğundan sipariş beklemeden proaktif eşleyin ya da siparişte gelmiş eşlenmemiş ürünleri tek tıkla eşleyin — mağaza ürün ID'si veriden gelir, elle yazmazsınız (typo riski yok)."
      >
        {/* Kayıtlı görünümler (§14): seçili site `?site=` ile adreste → çok mağazalı kurulumda
            "her açılışta mağazayı yeniden seç" derdini bitirir. Görünümler KİŞİSELDİR. */}
        <SavedViewsMenu page="mappings" />
      </PageHeader>
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
            {/* [G9] Varyasyonlu üründe katalogda hem EBEVEYN satırı hem her varyasyon durur; sipariş
                satırı her zaman bir varyasyona düştüğü için eşleme varyasyon-özel kurulur ve ebeveyn
                satırı (SQL üç-değerli mantığı gereği) varyasyon eşlemeleriyle asla eşleşmez. Üst
                şeritteki "eşlenmemiş katalog ürünü" sayacı bu satırı zaten HARİÇ tutar; operatör
                aradaki farkı burada da görsün diye açıklandı — amaç, alarmı susturmak için tehlikeli
                bir ürün-seviyesi catch-all eşleme kurulmasını önlemek. */}
            <p className="max-w-2xl text-sm text-muted-foreground">
              Bir mağaza seçin; o sitenin senkronlanmış tüm ürünlerini ADIYLA görün ve sipariş
              beklemeden panel ürününe eşleyin. Varyasyonlu (variable) ürünlerde <strong>varsayılan
              eylem varyasyonları eşlemektir</strong> — üst satır yalnızca ürün başlığıdır, eşlenmemiş
              görünmesi bir eksik değildir (dilerseniz tüm varyasyonlar için ürün-seviyesi tek eşleme
              de kurabilirsiniz).
            </p>
            {catalogError && (
              <p role="alert" className="text-sm text-destructive">
                Katalog yüklenemedi: {catalogError}
              </p>
            )}
            <CatalogTable
              sites={summary}
              siteId={siteValid ? site : undefined}
              rows={catalog}
              products={products}
            />
          </section>

          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <PackageSearch className="size-4 text-muted-foreground" aria-hidden />
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                Eşlenmemiş Gelen Ürünler
              </h2>
            </div>
            {/* PASİF eşleme: satır burada kalır (teslimat yapılamıyor) ama doğru eylem yeni eşleme
                kurmak DEĞİL — aynı anahtara ikinci eşleme kurulamaz (409). Satır "Eşleme pasif"
                rozetiyle işaretlenir ve tek eylem "Etkinleştir" olur. */}
            <p className="max-w-2xl text-sm text-muted-foreground">
              Gerçek siparişlerde gelmiş ama panelde teslim edilebilir bir ürüne bağlı olmayan
              mağaza ürünleri. Tek tıkla eşleyin. <strong>“Eşleme pasif”</strong> rozetli satırlarda
              eşleme zaten kuruludur ama kapalıdır — yeni eşleme eklenemez, “Etkinleştir” deyin.
            </p>
            <UnmappedTable rows={rows} products={products} />
          </section>

          {/* Eşleme SONRADAN yapıldığında eski satırlar kendiliğinden çözülmez (teslimat motoru
              product_id üzerinden tarar, eşlemesiz satırda o alan NULL'dır). Bu bölüm takılı
              satırları gösterir ve mevcut eşlemeyi geriye dönük uygular. */}
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Clock className="size-4 text-muted-foreground" aria-hidden />
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                Eşleme Bekleyen Sipariş Satırları
              </h2>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Mağaza ürünü panelde eşli olmadığı için teslim edilemeyen satırlar. Ürünü eşledikten
              sonra “Eşlemeyi Uygula” ile bu eski siparişler de teslimata alınır — yeni eşleme
              oluşturulmaz, yalnız sizin kurduğunuz eşleme geçmişe uygulanır.
            </p>
            {pendingError ? (
              <p role="alert" className="text-sm text-destructive">
                Bekleyen satır özeti alınamadı: {pendingError}
              </p>
            ) : (
              <PendingLinesPanel summary={pending} />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
