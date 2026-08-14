import Link from 'next/link';
import { ArrowLeft, Globe, Plus, Search, TriangleAlert, Users } from 'lucide-react';
import { EmptyState, PageHeader } from '../../components/ui/page-header';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { CustomersTable } from '../../components/customers-table';
import { CustomerSiteFilter } from '../../components/customer-site-filter';
import { CustomerSiteGrid } from '../../components/customer-site-grid';
import {
  CUSTOMERS_FETCH_LIMIT,
  getCustomerSiteSummary,
  getCustomers,
  getSitesForFilter,
  isValidSiteId,
  type CustomerRow,
  type CustomerSiteSummary,
  type SiteOption,
} from './queries';

export const dynamic = 'force-dynamic';

/**
 * Müşteriler — MAĞAZA → müşteri hiyerarşisi (kullanıcı geri bildirimi: "direkt müşteriler
 * çıkıyor, çok siteli kurulumda karışıyor; siteye girip müşterilerini görmek daha sağlıklı").
 *
 * Ekranın ÜÇ hâli var, üçü de aynı adres üzerinden (paylaşılabilir/yer imlenebilir URL):
 *   1. `/customers`            → MAĞAZA kartları (giriş seviyesi) + tüm mağazalarda arama
 *   2. `/customers?q=<terim>`  → aramanın SUNUCU-taraflı sonucu, hiyerarşiyi ATLAR
 *                                (operatör e-postayı biliyorsa hangi mağaza olduğunu bilmek
 *                                zorunda kalmasın — "genel arama yapılabilir" şartı)
 *   3. `/customers?site=<id>`  → o mağazanın müşterileri, sayılar o mağazaya kapsanmış
 *
 * Müşteri kaydı hâlâ e-posta bazlı GLOBAL'dir (etiket/not tek kayıt) — hiyerarşi yalnız
 * sunumdadır, veri modeli değişmedi.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ site?: string; q?: string }>;
}) {
  const { site: siteRaw, q } = await searchParams;
  const term = q?.trim() ?? '';
  /**
   * `?site=` adres çubuğundan gelir: bayat/elle düzenlenmiş bir değer API'de 500 üretip
   * ekranı hata kartına düşürüyordu. Geçersiz kimlik SÜZGEÇ SAYILMAZ → mağaza listesine
   * düşülür (hata değil): operatörün gördüğü şey "bozuk link" değil, giriş ekranıdır.
   */
  const site = isValidSiteId(siteRaw) ? siteRaw : undefined;
  /**
   * API/admin dağıtım sapmasına dayanıklılık: `site-summary` ucu eski API sürümünde YOK.
   * O durumda ekran hata kartına düşmez — eski davranışa (düz müşteri listesi) geri döner.
   * (Bu panelde admin ve api ayrı imajlar; biri önce dağıtılabiliyor.)
   */
  let summaryUnavailable = false;
  // Arama, site süzgecini EZER: operatör bir mağazanın içindeyken arama yaptığında
  // sonuç o mağazayla sınırlı kalsaydı "aradığım müşteri yok" yanılgısı doğardı.
  const mode: 'search' | 'site' | 'sites' = term ? 'search' : site ? 'site' : 'sites';

  let customers: CustomerRow[] = [];
  let siteSummary: CustomerSiteSummary[] = [];
  let sites: SiteOption[] = [];
  let truncated = false;
  let error: string | null = null;
  try {
    if (mode === 'sites') {
      try {
        siteSummary = await getCustomerSiteSummary();
      } catch {
        summaryUnavailable = true;
      }
    }
    if (mode !== 'sites' || summaryUnavailable) {
      const [res, siteList] = await Promise.all([
        getCustomers(mode === 'search' ? { search: term } : { siteId: site }),
        getSitesForFilter(),
      ]);
      customers = res.items;
      truncated = res.truncated;
      sites = siteList;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  const activeSite = sites.find((s) => s.id === site);
  const description =
    mode === 'search'
      ? `“${term}” için tüm mağazalarda arandı.`
      : mode === 'site'
        ? `${activeSite?.domain ?? 'Seçili mağaza'} müşterileri — sipariş/atama/değişim sayıları bu mağazaya göre.`
        : 'Mağazayı seçin, müşterileri içeride listelensin. E-postayı biliyorsanız aramayla doğrudan bulun.';

  return (
    <div>
      <PageHeader icon={Users} title="Müşteriler" description={description}>
        {/* Mağaza içindeyken hızlı geçiş için süzgeç kalır; giriş ekranında kartlar zaten
            aynı işi yapıyor, ikinci bir seçici gürültü olurdu. */}
        {mode === 'site' && <CustomerSiteFilter sites={sites} current={site} />}
      </PageHeader>

      {/* Arama HER hâlde üstte: hiyerarşi bir kısıt değil, varsayılan yol olmalı.
          Native form + GET → JS'siz çalışır, sonuç adres çubuğunda paylaşılabilir. */}
      <form action="/customers" method="get" className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            name="q"
            defaultValue={term}
            placeholder="Tüm mağazalarda e-posta ara…"
            aria-label="Tüm mağazalarda müşteri ara"
            className="bg-muted/40 pl-8"
          />
        </div>
        <Button type="submit" variant="outline" size="sm">
          Ara
        </Button>
        {mode !== 'sites' && (
          <Button asChild variant="ghost" size="sm">
            <Link href="/customers">
              <ArrowLeft className="size-3.5" /> Tüm mağazalar
            </Link>
          </Button>
        )}
      </form>

      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API&apos;ye ulaşılamadı: {error}</p>
        </Card>
      ) : mode === 'sites' && !summaryUnavailable ? (
        siteSummary.length === 0 ? (
          <EmptyState
            icon={Globe}
            title="Bağlı mağaza yok"
            description="Müşteriler mağazalardan gelen siparişlerden türetilir. Önce bir satış kanalı bağlayın."
          >
            <Button asChild size="sm">
              <Link href="/sites/new">
                <Plus className="size-3.5" /> Mağaza bağla
              </Link>
            </Button>
          </EmptyState>
        ) : (
          <CustomerSiteGrid sites={siteSummary} />
        )
      ) : (
        <>
          {summaryUnavailable && (
            <Alert variant="muted" className="mb-4">
              <TriangleAlert />
              <div>
                <AlertTitle>Mağaza görünümü şu an kullanılamıyor</AlertTitle>
                <AlertDescription>
                  API bu sürümde mağaza özetini vermiyor (dağıtım sırası) — tüm müşteriler düz
                  listede gösteriliyor. Arama ve müşteri detayı normal çalışır.
                </AlertDescription>
              </div>
            </Alert>
          )}
          {/* KIRPMA UYARISI MODA GÖRE AYRILIR: operatör zaten aramadayken "arama kutusunu
              kullanın" demek yol göstermiyor, üstelik "sonuç eksik olabilir"i gizliyor —
              bu panelin savaştığı "sessiz kırpma → o müşteri yok" sınıfının mesaj hâli.
              Sayı koda gömülmez, API sabitinden (CUSTOMERS_FETCH_LIMIT) türetilir. */}
          {truncated && (
            <Alert variant="warning" className="mb-4">
              <TriangleAlert />
              <div>
                <AlertTitle>Liste kırpıldı</AlertTitle>
                <AlertDescription>
                  {mode === 'search' ? (
                    <>
                      “{term}” araması{' '}
                      <strong>{CUSTOMERS_FETCH_LIMIT.toLocaleString('tr-TR')} kayıtla</strong>{' '}
                      sınırlandı — eşleşen müşterilerin tamamı listede olmayabilir. Daha dar bir
                      terim yazın (tam e-posta ya da alan adı) veya bir mağaza seçip içeride arayın.
                    </>
                  ) : (
                    <>
                      En yeni{' '}
                      <strong>{CUSTOMERS_FETCH_LIMIT.toLocaleString('tr-TR')} müşteri</strong>{' '}
                      gösteriliyor. Aradığınız müşteriyi bulamıyorsanız yukarıdaki arama kutusunu
                      kullanın — o arama sunucuda, TÜM kayıtlar üzerinde çalışır.
                    </>
                  )}
                </AlertDescription>
              </div>
            </Alert>
          )}
          {/* Sonuçsuz aramada TABLO ÇİZİLMEZ: boş tablo + sayfalama ("0 kayıt · Sayfa 1/1")
              aramanın kendisini gölgeliyordu. Tek mesaj, tek çıkış yolu. */}
          {mode === 'search' && customers.length === 0 ? (
            <EmptyState
              icon={Search}
              title={`“${term}” ile eşleşen müşteri yok`}
              description="Arama tüm mağazalarda, sunucu tarafında yapıldı. E-postanın bir parçasıyla (ör. alan adı) deneyin ya da mağaza listesine dönün."
            >
              <Button asChild variant="outline" size="sm">
                <Link href="/customers">
                  <ArrowLeft className="size-3.5" /> Mağaza listesi
                </Link>
              </Button>
            </EmptyState>
          ) : (
            <CustomersTable customers={customers} siteScoped={mode === 'site'} />
          )}
        </>
      )}
    </div>
  );
}
