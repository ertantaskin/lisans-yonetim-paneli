import Link from 'next/link';
import { Inbox, Clock3, Boxes, PackageX, ArrowRight } from 'lucide-react';
import { apiGet, type OrderRow, type ProductRow } from '../../lib/api';
import { PageHeader, EmptyState } from '../../components/ui/page-header';
import { StatTile } from '../../components/ui/stat-tile';
import { Card } from '../../components/ui/card';
import { StatusBadge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../components/ui/table';
import { relativeTime, waitTone } from '../../lib/utils';

export const dynamic = 'force-dynamic';

const waitColor: Record<string, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  muted: 'text-muted',
};

export default async function DashboardPage() {
  let orders: OrderRow[] = [];
  let products: ProductRow[] = [];
  let error: string | null = null;
  try {
    [orders, products] = await Promise.all([
      apiGet<OrderRow[]>('/v1/admin/pending'),
      apiGet<ProductRow[]>('/v1/admin/products'),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  const pendingCount = orders.filter((o) => o.status === 'pending').length;
  const partialCount = orders.filter((o) => o.status === 'partial').length;
  const outOfStock = products.filter((p) => p.availableStock === 0).length;
  const totalStock = products.reduce((s, p) => s + (p.availableStock || 0), 0);

  return (
    <div>
      <PageHeader
        title="Bekleyen Teslimatlar"
        description="Stok bekleyen veya kısmen teslim edilmiş siparişler. Stok girince partial-auto olanlar kendiliğinden tamamlanır."
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/stock">
            <Boxes className="size-4" /> Stok Gir
          </Link>
        </Button>
      </PageHeader>

      {error ? (
        <Card className="p-6">
          <p className="text-sm text-danger">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Bekleyen sipariş" value={pendingCount} icon={Inbox} tone="warning" hint="stok bekliyor" />
            <StatTile label="Kısmi teslim" value={partialCount} icon={Clock3} tone="accent" hint="kalanı hazırlanıyor" />
            <StatTile label="Toplam stok" value={totalStock.toLocaleString('tr-TR')} icon={Boxes} tone="success" hint={`${products.length} ürün`} />
            <StatTile
              label="Stoksuz ürün"
              value={outOfStock}
              icon={PackageX}
              tone={outOfStock > 0 ? 'danger' : 'success'}
              hint={outOfStock > 0 ? 'stok girişi bekliyor' : 'hepsi stokta'}
            />
          </div>

          <Card>
            {orders.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="Bekleyen teslimat yok"
                description="Tüm siparişler teslim edildi. Yeni sipariş geldiğinde burada görünür."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Sipariş No</TableHead>
                    <TableHead>Müşteri</TableHead>
                    <TableHead>Durum</TableHead>
                    <TableHead>Bekleme</TableHead>
                    <TableHead className="text-right">Aksiyon</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-medium text-ink">{o.remoteOrderId}</TableCell>
                      <TableCell className="text-ink/80">{o.customerEmail}</TableCell>
                      <TableCell>
                        <StatusBadge status={o.status} />
                      </TableCell>
                      <TableCell className={`text-xs font-medium ${waitColor[waitTone(o.createdAt)]}`}>
                        {relativeTime(o.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button asChild variant="ghost" size="sm">
                          <Link href={`/orders/${o.id}`}>
                            İşle <ArrowRight className="size-3.5" />
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
