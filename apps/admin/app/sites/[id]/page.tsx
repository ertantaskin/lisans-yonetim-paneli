import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  FlaskConical,
  Gauge,
  Globe,
  Mail,
  Receipt,
  ShoppingCart,
  Users,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { StatTile } from '../../../components/ui/stat-tile';
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
import { getSite, type SiteDetail } from './queries';
import { getCustomers, type CustomerRow } from '../../customers/queries';
import { SiteConfigForm } from './site-config-form';
import { SiteStatusToggle } from './site-status-toggle';

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

  // Bu sitenin müşterileri (site → müşteri hiyerarşisi). Best-effort: hata site sayfasını bozmaz.
  let siteCustomers: CustomerRow[] = [];
  try {
    siteCustomers = (await getCustomers({ siteId: site.id })).slice(0, 8);
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
              className="hidden size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground shadow-sm sm:flex"
              aria-hidden
            >
              <Globe className="size-5" />
            </span>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">{site.domain}</h1>
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

      {/* Özet istatistikler */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Sipariş" value={orderCount} icon={ShoppingCart} tone="neutral" />
        <StatTile
          label="Bugün / Kota"
          value={quotaValue(todayOrderCount, site.salesDailyQuota)}
          icon={Gauge}
          tone={quotaTone}
          hint={site.salesDailyQuota == null ? 'limitsiz' : 'günlük satış kotası'}
        />
        <StatTile label="Ürün Eşleme" value={mappingCount} icon={Boxes} tone="accent" />
        <StatTile
          label="Gönderen"
          value={site.senderEmail ?? '—'}
          icon={Mail}
          tone="neutral"
          hint={site.senderEmail ? undefined : 'varsayılan gönderen'}
        />
      </div>

      {/* Yapılandırma */}
      <Card>
        <CardHeader>
          <CardTitle icon={Globe}>Yapılandırma</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4 sm:block">
              <dt className="text-muted-foreground">Domain</dt>
              <dd className="font-medium text-foreground">{site.domain}</dd>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <dt className="text-muted-foreground">Tip</dt>
              <dd className="font-medium text-foreground">{siteTypeLabel(site.type)}</dd>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <dt className="text-muted-foreground">Gönderen E-posta</dt>
              <dd className="font-medium text-foreground">{site.senderEmail ?? '—'}</dd>
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
            <SiteConfigForm
              siteId={site.id}
              salesDailyQuota={site.salesDailyQuota}
              sandbox={site.sandbox}
              senderEmail={site.senderEmail}
              webhookUrl={site.webhookUrl}
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
