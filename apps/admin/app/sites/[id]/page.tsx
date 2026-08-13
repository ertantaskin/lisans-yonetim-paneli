import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  FlaskConical,
  Gauge,
  Globe,
  Plug,
  Receipt,
  ShoppingCart,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { StatStrip } from '../../../components/ui/stat-tile';
import { StatusBadge, Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { EmptyState } from '../../../components/ui/page-header';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table';
import { ApiError } from '../../../lib/api';
import { siteTypeLabel } from '../../../lib/labels';
import { formatDate } from '../../../lib/utils';
import { getSite, type SiteDetail } from './queries';
import { getCustomers, type CustomerRow } from '../../customers/queries';
import { SiteConfigForm } from './site-config-form';
import { SiteStatusToggle } from './site-status-toggle';
import { IssueConnectCode } from './issue-connect-code';

export const dynamic = 'force-dynamic';

/** Kota kullanımı metni: kota null ise "limitsiz", değilse "kullanılan / kota". */
function quotaValue(used: number, quota: number | null): string {
  return quota == null ? `${used}` : `${used} / ${quota}`;
}

export default async function SiteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let data: SiteDetail | null = null;
  let error: string | null = null;
  try {
    data = await getSite(id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/sites">
            <ArrowLeft /> Siteler
          </Link>
        </Button>
        <Card className="p-6">
          <p className="text-sm text-destructive">Site yüklenemedi: {error}</p>
        </Card>
      </div>
    );
  }

  const { site, mappingCount, orderCount, todayOrderCount, recentOrders } = data;
  // Savunmacı: api ve admin AYRI imajlar — sürüm sapmasında bu alanlar hiç GELMEYEBİLİR.
  // "alan yok" ile "hiç bağlanmadı" AYRI şeydir: alan gelmediyse yanlış alarm basmak yerine
  // dürüstçe "bilinmiyor" (—) gösterilir.
  const pluginInfoAvailable =
    site.pluginVersion !== undefined || site.pluginVersionAt !== undefined;
  const pluginVersion = site.pluginVersion ?? null;
  const pluginVersionAt = site.pluginVersionAt ?? null;

  // Bu sitenin müşterileri (site → müşteri hiyerarşisi). Best-effort: hata site sayfasını bozmaz.
  let siteCustomers: CustomerRow[] = [];
  try {
    siteCustomers = (await getCustomers({ siteId: site.id })).items.slice(0, 8);
  } catch {
    siteCustomers = [];
  }
  // Kota tanımlıysa ve bugünkü sipariş kotaya ulaştıysa uyarı tonu.
  const quotaTone =
    site.salesDailyQuota != null && todayOrderCount >= site.salesDailyQuota ? 'warning' : 'neutral';

  return (
    <div className="space-y-6">
      {/* Başlık */}
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/sites">
            <ArrowLeft /> Siteler
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span
              className="hidden size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-foreground shadow-xs sm:flex"
              aria-hidden
            >
              <Globe className="size-5" />
            </span>
            <div>
              {/* break-all ŞART: domain kırılma fırsatı olmayan tek kelimedir (nokta UAX14'te
                  sarma noktası üretmez) ve text-2xl'de hızla taşar. break-words TEK BAŞINA
                  işe yaramıyor (min-content boyutunu küçültmez); ölçüldü: 43px taşma → 0. */}
              <h1 className="break-all text-2xl font-semibold tracking-tight text-foreground">
                {site.domain}
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge variant="outline">{siteTypeLabel(site.type)}</Badge>
                <StatusBadge status={site.status} />
                {site.sandbox && (
                  <Badge variant="warning">
                    <FlaskConical />
                    sandbox
                  </Badge>
                )}
              </div>
            </div>
          </div>
          <SiteStatusToggle siteId={site.id} status={site.status} />
        </div>
      </div>

      {/* Özet istatistikler — tek satır şerit (Gönderen aşağıdaki Yapılandırma'da gösterilir) */}
      <div className="space-y-2">
        <StatStrip
          items={[
            { icon: ShoppingCart, label: 'Sipariş', value: orderCount },
            {
              icon: Gauge,
              label: 'Bugün / Kota',
              value: quotaValue(todayOrderCount, site.salesDailyQuota),
              tone: quotaTone === 'warning' ? 'warning' : undefined,
              hint: site.salesDailyQuota == null ? 'limitsiz' : 'günlük satış kotası',
            },
            { icon: Boxes, label: 'Ürün Eşleme', value: mappingCount },
          ]}
        />
        {/* Sayaç → eylem köprüsü: "bu mağazanın hangi ürünleri eşli / hangileri bekliyor"
            sorusu /mappings?site= ile TEK tıkta yanıtlanır (sidebar'dan gidip site seçiciden
            aynı siteyi yeniden bulmak gerekmez). Müşteriler kartındaki desenin aynısı. */}
        <div className="flex flex-wrap items-center gap-x-4">
          <Button asChild variant="link" size="sm" className="h-auto p-0">
            <Link href={`/mappings?site=${site.id}`}>
              Ürün eşlemelerini yönet <ArrowRight />
            </Link>
          </Button>
        </div>
      </div>

      {/* Bağlantı sağlığı (§14) — "aktif" rozeti yalnız 'askıya alınmadı' demek; mağazanın
          panele GERÇEKTEN bağlı olup olmadığını kurulu eklenti sürümü bildirimi kanıtlar. */}
      <Card>
        <CardHeader>
          <CardTitle icon={Plug}>Bağlantı</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4 sm:block">
              <dt className="text-muted-foreground">Kurulu eklenti sürümü</dt>
              <dd className="font-medium text-foreground">
                {pluginVersion ? (
                  <Badge variant="success">v{pluginVersion}</Badge>
                ) : pluginInfoAvailable ? (
                  <Badge variant="warning">
                    <TriangleAlert />
                    hiç bağlanmadı
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <dt className="text-muted-foreground">Son bildirim</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {pluginVersionAt ? formatDate(pluginVersionAt) : '—'}
              </dd>
            </div>
          </dl>
          {!pluginVersion && pluginInfoAvailable && (
            <p className="text-xs text-muted-foreground">
              Bu site panele hiç imzalı istek göndermedi — eklenti kurulmamış ya da bağlan kodu
              hiç kullanılmamış olabilir. Aşağıdan yeni bir bağlan kodu üretip mağazaya girin.
            </p>
          )}
          <IssueConnectCode siteId={site.id} domain={site.domain} />
        </CardContent>
      </Card>

      {/* Yapılandırma */}
      <Card>
        <CardHeader>
          <CardTitle icon={Globe}>Yapılandırma</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4 sm:block">
              <dt className="text-muted-foreground">Domain</dt>
              {/* min-w-0 + break-words birlikte GEREKLİ: sm altında satır flex olduğu için
                  dd'nin min-width:auto tabanı tüm domaini genişletir (break-words tek
                  başına min-content'i küçültmez); sm:block'ta min-w-0 zararsız no-op. */}
              <dd className="min-w-0 break-words font-medium text-foreground">{site.domain}</dd>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <dt className="text-muted-foreground">Tip</dt>
              <dd className="font-medium text-foreground">{siteTypeLabel(site.type)}</dd>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <dt className="text-muted-foreground">Gönderen E-posta</dt>
              {/* Domain satırıyla aynı gerekçe: uzun e-posta kırılmasız tek dizedir. */}
              <dd className="min-w-0 break-words font-medium text-foreground">
                {site.senderEmail ?? '—'}
              </dd>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <dt className="text-muted-foreground">Günlük Satış Kotası</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {site.salesDailyQuota == null ? 'limitsiz' : site.salesDailyQuota}
              </dd>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <dt className="text-muted-foreground">Sandbox</dt>
              <dd className="font-medium text-foreground">{site.sandbox ? 'açık' : 'kapalı'}</dd>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <dt className="text-muted-foreground">Dinamik Satış Kotası</dt>
              <dd className="font-medium text-foreground">
                {site.dynamicQuotaEnabled ? `açık (× ${site.reviewMultiplier})` : 'kapalı'}
              </dd>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <dt className="text-muted-foreground">Oluşturulma</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {new Date(site.createdAt).toLocaleString('tr-TR', {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}
              </dd>
            </div>
          </dl>

          <div className="mt-6 border-t border-border pt-5">
            <h3 className="mb-3 text-sm font-medium text-foreground">Düzenle</h3>
            {/* adminOrderUrlTemplateManual (0026) MUTLAKA geçilmeli: prop yokken form DAİMA
                "mağazanın bildirdiği değer kullanılıyor" diyordu → elle girilmiş şablonu
                mağazadan gelmiş sanan operatör "senkron düzeltir" diye bekliyordu, oysa
                katalog senkronu elle girilen değeri ASLA ezmez. */}
            <SiteConfigForm
              siteId={site.id}
              salesDailyQuota={site.salesDailyQuota}
              sandbox={site.sandbox}
              senderEmail={site.senderEmail}
              webhookUrl={site.webhookUrl}
              adminOrderUrlTemplate={site.adminOrderUrlTemplate ?? null}
              adminOrderUrlTemplateManual={site.adminOrderUrlTemplateManual ?? false}
              dynamicQuotaEnabled={site.dynamicQuotaEnabled}
              reviewMultiplier={site.reviewMultiplier}
            />
          </div>
        </CardContent>
      </Card>

      {/* Son siparişler */}
      <Card>
        <CardHeader>
          <CardTitle icon={Receipt}>Son Siparişler</CardTitle>
        </CardHeader>
        <CardContent className={recentOrders.length === 0 ? '' : 'p-0'}>
          {recentOrders.length === 0 ? (
            <EmptyState icon={Receipt} title="Sipariş yok" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Sipariş No</TableHead>
                  <TableHead>Durum</TableHead>
                  <TableHead>Tarih</TableHead>
                  <TableHead className="text-right">Detay</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentOrders.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium tabular-nums text-foreground">
                      {o.remoteOrderId}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={o.status} />
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {new Date(o.createdAt).toLocaleString('tr-TR', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/orders/${o.id}`}>
                          Aç <ArrowRight />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Bu sitenin müşterileri (site → müşteri hiyerarşisi) */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle icon={Users}>Müşteriler</CardTitle>
          {siteCustomers.length > 0 && (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/customers?site=${site.id}`}>
                Tümünü gör <ArrowRight />
              </Link>
            </Button>
          )}
        </CardHeader>
        <CardContent className={siteCustomers.length === 0 ? '' : 'p-0'}>
          {siteCustomers.length === 0 ? (
            <EmptyState icon={Users} title="Müşteri yok" description="Bu siteden henüz sipariş veren yok." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Müşteri</TableHead>
                  <TableHead className="text-right">Sipariş</TableHead>
                  <TableHead className="text-right">Atama</TableHead>
                  <TableHead>Son Sipariş</TableHead>
                  <TableHead className="text-right">Detay</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {siteCustomers.map((c) => (
                  <TableRow key={c.email}>
                    <TableCell className="font-medium text-foreground">{c.email}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.orderCount}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {c.assignmentCount}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {c.lastOrderAt
                        ? new Date(c.lastOrderAt).toLocaleDateString('tr-TR', { dateStyle: 'short' })
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/customers/${encodeURIComponent(c.email)}`}>
                          Aç <ArrowRight />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
