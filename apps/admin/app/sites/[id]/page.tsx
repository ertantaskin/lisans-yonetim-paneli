import Link from 'next/link';
import {
  ArrowLeft,
  Boxes,
  FlaskConical,
  Gauge,
  Globe,
  Mail,
  Receipt,
  ShoppingCart,
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
import { getSite, type SiteDetail } from './queries';
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
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{site.domain}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">{site.type}</Badge>
              <StatusBadge status={site.status} />
              {site.sandbox && (
                <Badge variant="warning">
                  <FlaskConical />
                  sandbox
                </Badge>
              )}
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
          <CardTitle className="flex items-center gap-2">
            <Globe className="size-4 text-muted-foreground" /> Yapılandırma
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4 sm:block">
              <dt className="text-muted-foreground">Domain</dt>
              <dd className="font-medium text-foreground">{site.domain}</dd>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <dt className="text-muted-foreground">Tip</dt>
              <dd className="font-medium text-foreground">{site.type}</dd>
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
            />
          </div>
        </CardContent>
      </Card>

      {/* Son siparişler */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Receipt className="size-4 text-muted-foreground" /> Son Siparişler
          </CardTitle>
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
                        <Link href={`/orders/${o.id}`}>Aç</Link>
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
