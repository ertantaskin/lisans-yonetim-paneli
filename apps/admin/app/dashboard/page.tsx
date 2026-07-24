import Link from 'next/link';
import {
  ListChecks,
  ShoppingCart,
  PackageX,
  RefreshCw,
  ShieldAlert,
  Boxes,
  ArrowRight,
  Inbox,
  Globe,
  Truck,
  LayoutDashboard,
} from 'lucide-react';
import { getDashboard, type DashboardSummary } from './queries';
import { PageHeader, EmptyState } from '../../components/ui/page-header';
import { StatTile } from '../../components/ui/stat-tile';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { StatusBadge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';

export const dynamic = 'force-dynamic';

/** Genel-bakış hızlı erişim kısayolları (kabuk navigasyonuyla aynı hedefler). */
const QUICK_LINKS: Array<{ label: string; href: string; icon: typeof Inbox }> = [
  { label: 'Bekleyen Teslimatlar', href: '/pending', icon: Inbox },
  { label: 'Siparişler', href: '/orders', icon: ShoppingCart },
  { label: 'Stok & Ürünler', href: '/stock', icon: Boxes },
  { label: 'Kanallar / Siteler', href: '/sites', icon: Globe },
  { label: 'Tedarikçiler', href: '/suppliers', icon: Truck },
];

export default async function DashboardOverviewPage() {
  let data: DashboardSummary | null = null;
  let error: string | null = null;
  try {
    data = await getDashboard();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  if (error || !data) {
    return (
      <div>
        <PageHeader icon={LayoutDashboard} title="Genel Bakış" description="Panel özeti ve günün operasyonel durumu." />
        <Card className="p-6">
          <p className="text-sm text-destructive">Genel bakış yüklenemedi: {error}</p>
        </Card>
      </div>
    );
  }

  const {
    pendingLines,
    todayOrders,
    lowStockCount,
    openReplacements,
    openSecurityEvents,
    totalAvailableStock,
    recentOrders,
  } = data;

  return (
    <div>
      <PageHeader icon={LayoutDashboard} title="Genel Bakış" description="Panel özeti ve günün operasyonel durumu.">
        <Button asChild variant="outline" size="sm">
          <Link href="/pending">
            <Inbox className="size-4" /> Bekleyenler
          </Link>
        </Button>
      </PageHeader>

      {/* KPI ızgarası */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          label="Bekleyen Satır"
          value={pendingLines}
          icon={ListChecks}
          tone={pendingLines > 0 ? 'warning' : 'success'}
          hint={pendingLines > 0 ? 'teslim bekliyor' : 'tümü teslim edildi'}
        />
        <StatTile
          label="Bugünkü Sipariş"
          value={todayOrders}
          icon={ShoppingCart}
          tone="accent"
          hint="gün başından beri"
        />
        <StatTile
          label="Toplam Stok"
          value={totalAvailableStock.toLocaleString('tr-TR')}
          icon={Boxes}
          tone="success"
          hint="atanabilir kapasite"
        />
        <StatTile
          label="Düşük Stok"
          value={lowStockCount}
          icon={PackageX}
          tone={lowStockCount > 0 ? 'danger' : 'success'}
          hint={lowStockCount > 0 ? 'eşiğin altında' : 'eşik üstü'}
        />
        <StatTile
          label="Açık Değişim"
          value={openReplacements}
          icon={RefreshCw}
          tone={openReplacements > 0 ? 'warning' : 'neutral'}
          hint={openReplacements > 0 ? 'yanıt bekliyor' : 'açık talep yok'}
        />
        <StatTile
          label="Güvenlik Olayı"
          value={openSecurityEvents}
          icon={ShieldAlert}
          tone={openSecurityEvents > 0 ? 'warning' : 'neutral'}
          hint="son 7 gün"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Son siparişler */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShoppingCart className="size-4 text-muted-foreground" /> Son Siparişler
            </CardTitle>
          </CardHeader>
          <CardContent className={recentOrders.length === 0 ? '' : 'p-0'}>
            {recentOrders.length === 0 ? (
              <EmptyState icon={Inbox} title="Sipariş yok" description="Yeni sipariş geldiğinde burada görünür." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Sipariş No</TableHead>
                    <TableHead>Müşteri</TableHead>
                    <TableHead>Durum</TableHead>
                    <TableHead>Tarih</TableHead>
                    <TableHead className="text-right">Detay</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentOrders.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-medium text-foreground">{o.remoteOrderId}</TableCell>
                      <TableCell className="text-foreground/80">{o.customerEmail}</TableCell>
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
                            Aç <ArrowRight className="size-3.5" />
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

        {/* Hızlı erişim */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArrowRight className="size-4 text-muted-foreground" /> Hızlı Erişim
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {QUICK_LINKS.map((l) => {
              const Icon = l.icon;
              return (
                <Button
                  key={l.href}
                  asChild
                  variant="outline"
                  className="justify-start"
                >
                  <Link href={l.href}>
                    <Icon className="size-4" /> {l.label}
                  </Link>
                </Button>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
