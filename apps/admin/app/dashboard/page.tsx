import Link from 'next/link';
import {
  ShoppingCart,
  Boxes,
  ShieldAlert,
  Inbox,
  Globe,
  Truck,
  Link2,
  LayoutDashboard,
  PackageSearch,
  TriangleAlert,
  Unlink,
} from 'lucide-react';
import { getDashboard, type DashboardSummary } from './queries';
import { apiGet } from '../../lib/api';
import { PageHeader } from '../../components/ui/page-header';
import { StatStrip, type StatStripItem } from '../../components/ui/stat-tile';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import {
  LiveKpiStrip,
  LiveOrdersCard,
  LiveStatus,
  LiveSupportCard,
} from '../../components/live/live-feed';
import type { LivePayload, LiveStats } from '../../lib/live-types';

export const dynamic = 'force-dynamic';

/**
 * Sunucu tarafındaki ilk kare için satır sayısı. `LiveProvider`'ın varsayılan `limit`
 * değeriyle AYNI olmalı (components/live/live-provider.tsx) — aksi halde ilk canlı poll
 * listenin uzunluğunu değiştirir ve ekran zıplar.
 */
const LIVE_LIMIT = 15;

/** Alt satır hızlı erişim kısayolları (kabuk navigasyonuyla aynı hedefler). */
const QUICK_LINKS: Array<{ label: string; href: string; icon: typeof Inbox }> = [
  { label: 'Bekleyen Teslimatlar', href: '/pending', icon: Inbox },
  { label: 'Siparişler', href: '/orders', icon: ShoppingCart },
  { label: 'Stok & Ürünler', href: '/stock', icon: Boxes },
  { label: 'Ürün Eşleştirme', href: '/mappings', icon: Link2 },
  { label: 'Kanallar / Siteler', href: '/sites', icon: Globe },
  { label: 'Tedarikçiler', href: '/suppliers', icon: Truck },
];

/**
 * Genel Bakış = operatörün İŞ İSTASYONU (§17). Mesai boyunca açık kalması tasarlanmıştır:
 *
 *  1. Sunucu, canlı akışın İLK KARESİNİ de çeker (`/v1/admin/live`) → sayaçlar ve iki liste
 *     ilk boyamada DOLU gelir; ekran asla boş/iskelet açılmaz.
 *  2. Sonrasını `useLive()` devralır: panel genelinde TEK poll (15 sn, ETag'li; sekme
 *     arkadayken DURMAZ, 60 sn'ye seyrelir — arka plandayken gelen sipariş de sayılsın diye)
 *     — bu ekran kendi isteğini AÇMAZ. Yeni kayıtlar "YENİ" işaretiyle KALICI olarak durur
 *     (işaret satır açılınca ya da "Okundu" ile kalkar).
 *  3. Canlı akışta olmayan yavaş metrikler (bugünkü sipariş / stok / güvenlik) altta ince
 *     bir şeritte sunucu özetiyle durur — gürültü yapmadan bağlam verir.
 *
 * İki çekim BAĞIMSIZ: özet başarısız olsa bile sayfa render edilir (yalnız uyarı bandı çıkar),
 * anlık görüntü başarısız olsa bile istemci poll'u devreye girip listeleri doldurur.
 */
export default async function DashboardOverviewPage() {
  // İki bağımsız çekim PARALEL ve birbirinden BAĞIMSIZ hataya dayanıklı:
  //  • summary  → yavaş metrikler (bugünkü sipariş / stok / güvenlik)
  //  • snapshot → canlı akışın İLK karesi (istemci poll'unun döneceği gövdenin aynısı)
  // Snapshot sunucuda bir kez alınır; sonrasını tek canlı poller devralır (ek istek yok).
  const [summaryRes, snapshotRes] = await Promise.allSettled([
    getDashboard(),
    apiGet<LivePayload>(`/v1/admin/live?limit=${LIVE_LIMIT}`),
  ]);

  const data: DashboardSummary | null =
    summaryRes.status === 'fulfilled' ? summaryRes.value : null;
  const error =
    summaryRes.status === 'rejected'
      ? summaryRes.reason instanceof Error
        ? summaryRes.reason.message
        : 'Bağlantı hatası'
      : null;

  // `null` tohum = sunucu da veremedi → akış kartları "kayıt yok" yerine iskelet gösterir.
  const snapshot: LivePayload | null =
    snapshotRes.status === 'fulfilled' ? snapshotRes.value : null;

  /**
   * Sayaç okuma — SAVUNMACI: alan hiç gelmemişse (api/admin dağıtım sapması) `null` döner.
   * `null` "veri yok" demektir; 0 ile karıştırılmaz (0 = "ölçtüm, iş yok").
   */
  const readCount = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  /**
   * GERÇEK TALEP (§3/§4): en az bir eşlemesiz aktif satırı olan sipariş sayısı. Panelin en
   * sessiz arızası budur — o satırlar operatör ELLE eşleme kurana kadar teslim EDİLEMEZ.
   * Kırmızı bant YALNIZ bu sayaçtan türetilir; sayaç eşleme kurulunca gerçekten söner.
   * İki bağımsız kaynaktan okunur (sunucu özeti düşse bile canlı anlık görüntü verir);
   * alan hiç gelmezse 0 kalır → bant HİÇ çizilmez (yanlış alarm yok).
   */
  const unmappedOrders =
    readCount(data?.unmappedOrders) ?? readCount(snapshot?.stats?.unmappedOrders) ?? 0;

  /**
   * BİLGİ sayacı: katalogda panel eşlemesi olmayan mağaza ürünü. ALARM DEĞİL — katalog
   * mağazanın TÜM ürünlerini taşır (kargo/hizmet/fiziksel ürün dahil), yani "eşlenmemiş"
   * ≠ "eşlenmesi gereken" ve sayı doğru çalışan bir mağazada da kalıcı olarak > 0 kalır.
   * Kırmızı bant buradan türetilse HİÇBİR doğru işlemle sönmezdi (alarm körlüğü) ve
   * operatörü lisans taşımayan ürünleri de eşlemeye (tehlikeli "her şeyi eşle") iterdi.
   * `null` = alan gelmedi → hücre hiç çizilmez (uydurma 0 gösterilmez).
   */
  const unmappedCatalogProducts =
    readCount(data?.unmappedCatalogProducts) ?? readCount(snapshot?.stats?.unmappedCatalogProducts);

  /**
   * KPI ŞERİDİ İÇİN SUNUCU ÖZETİNDEN TOHUM.
   *
   * `/live` düştüğünde şerit tüm hücreleri "—" gösteriyordu; oysa `getDashboard()`
   * başarılıysa AYNI sayaçlar zaten elimizde. `unmappedOrders` için bu geri düşüş
   * yukarıda (bant) ZATEN vardı, diğer metriklere uygulanmamıştı.
   *
   * EŞLEME GÜVENLİ — "aynı kavramın iki tanımı" DEĞİL: API bu sayaçların ikisini de TEK
   * kaynaktan üretir (`dashboard.service`: `summary()` ve `live()` aynı `liveCounters()`
   * sorgusunu ve aynı `lowStockCountCached()` önbelleğini paylaşır; kodda "canlı ile ortak"
   * diye yazılı). Yani `openReplacements === stats.openSupport` ve
   * `lowStockCount === stats.lowStockProducts` tanım gereği aynıdır.
   *
   * `heldOrders` BİLEREK EKSİK: sunucu özeti onu döndürmez → uydurulmaz, hücre "—" kalır
   * (yanlış "0" göstermek "inceleme kuyruğu boş" demek olurdu).
   *
   * Canlı yanıt geldiği anda `LiveKpiStrip` zaten kendi verisine geçer (bu tohum yalnız
   * ilk boyama/`/live` erişilemez hâli içindir); snapshot varsa onun değerleri kazanır.
   */
  const summarySeed: Partial<LiveStats> = {};
  if (data) {
    const seed = (key: keyof LiveStats, v: unknown) => {
      const n = readCount(v);
      if (n !== null) summarySeed[key] = n;
    };
    seed('pendingLines', data.pendingLines);
    seed('unmappedLines', data.unmappedLines);
    seed('openSupport', data.openReplacements);
    seed('lowStockProducts', data.lowStockCount);
    seed('unmappedOrders', data.unmappedOrders);
    seed('unmappedCatalogProducts', data.unmappedCatalogProducts);
  }
  const kpiSeed: Partial<LiveStats> = { ...summarySeed, ...(snapshot?.stats ?? {}) };

  // Yavaş metrik şeridi: sunucu özeti gelmediyse o üç hücre düşer, bilgi sayacı (varsa) kalır.
  const stripItems: StatStripItem[] = [];
  if (data) {
    stripItems.push(
      { icon: ShoppingCart, label: 'Bugünkü sipariş', value: data.todayOrders },
      {
        icon: Boxes,
        label: 'Atanabilir stok',
        value: data.totalAvailableStock.toLocaleString('tr-TR'),
      },
      {
        icon: ShieldAlert,
        label: 'Güvenlik olayı',
        value: data.openSecurityEvents,
        hint: 'son 7 gün',
        tone: data.openSecurityEvents > 0 ? 'warning' : 'default',
      },
    );
  }
  if (unmappedCatalogProducts !== null) {
    stripItems.push({
      icon: PackageSearch,
      label: 'Panelde eşlenmemiş mağaza ürünü',
      value: unmappedCatalogProducts.toLocaleString('tr-TR'),
      // Nötr ton (uyarı DEĞİL) + beklentiyi düzelten açıklama.
      hint: 'hepsinin eşlenmesi gerekmez; yalnız lisans taşıyanları eşleyin',
      tone: 'default',
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        icon={LayoutDashboard}
        title="Genel Bakış"
        description="İş istasyonu — gelen siparişler ve destek talepleri canlı olarak buradan izlenir."
      >
        <LiveStatus />
      </PageHeader>

      {/*
        Eşleme uyarı bandı — TEK bant, en üstte. YALNIZ gerçek talepten (eşlemesiz aktif satırı
        olan sipariş) doğar: alarm ancak yapılacak İŞ varken çıkar ve iş bitince söner.
        Katalog sayacından (bilgi) ASLA türetilmez — o sayı hiçbir doğru işlemle sıfırlanmaz.
      */}
      {unmappedOrders > 0 && (
        <Alert variant="destructive">
          <Unlink />
          {/* `min-w-0 flex-1`: ikon kardeşiyle aynı satırda, uzun metinde taşma yapmaz. */}
          <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <AlertTitle>Eşleme bekleyen sipariş var</AlertTitle>
              <AlertDescription>
                {/*
                  Cümle SATIR düzeyinde kurulur: siparişin tamamı eşlemesiz olmak zorunda değil —
                  çok kalemli bir siparişin tek kalemi eşlemesizse sipariş 'bekliyor' görünür ama
                  o kalem teslim edilemez (asıl operatör şikâyeti buydu).
                */}
                <strong className="tabular-nums">{unmappedOrders}</strong> siparişte mağaza ürünü
                panel ürününe bağlı değil — bu satırlar eşleme yapılana kadar teslim edilemez.
              </AlertDescription>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button asChild size="sm">
                <Link href="/mappings">
                  <Link2 className="size-3.5" /> Ürün Eşleştirme
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/pending">
                  <Inbox className="size-3.5" /> Bekleyen
                </Link>
              </Button>
            </div>
          </div>
        </Alert>
      )}

      {error && (
        <Alert variant="warning">
          <TriangleAlert />
          <div>
            <AlertTitle>Sunucu özeti yüklenemedi</AlertTitle>
            <AlertDescription>
              {error} — canlı akış ayrı yoldan beslenir, aşağıdaki listeler çalışmaya devam eder.
            </AlertDescription>
          </div>
        </Alert>
      )}

      {/* Canlı iş kuyrukları: her hücre ilgili çalışma ekranına bağlantı.
          Tohum: canlı anlık görüntü + (o düştüyse) sunucu özetinden türetilen sayaçlar. */}
      <LiveKpiStrip initialStats={kpiSeed} />

      {/* Ana akış: solda siparişler, sağda destek talepleri.
          Kartlar arası boşluk sözleşme gereği 24px (gap-6) — 16px'te iki kart sıkışık duruyordu. */}
      <div className="grid items-start gap-6 [&>*]:min-w-0 lg:grid-cols-2">
        <LiveOrdersCard initialOrders={snapshot?.orders ?? null} />
        <LiveSupportCard initialSupports={snapshot?.supports ?? null} />
      </div>

      {/*
        Yavaş metrikler (sunucu özeti) — canlı akışta yer kaplamasın diye ince şeritte.
        Katalog bilgi sayacı da BURADA durur: alarm değil, bağlam.
      */}
      {stripItems.length > 0 && <StatStrip items={stripItems} />}

      {/* Hızlı erişim */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-medium text-muted-foreground">Hızlı erişim</span>
        {QUICK_LINKS.map((l) => {
          const Icon = l.icon;
          return (
            <Button key={l.href} asChild variant="outline" size="sm">
              <Link href={l.href}>
                <Icon className="size-3.5" /> {l.label}
              </Link>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
