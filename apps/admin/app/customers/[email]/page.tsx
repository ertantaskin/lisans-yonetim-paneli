import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ShoppingCart,
  KeyRound,
  RefreshCw,
  ShieldAlert,
  Tags,
  Receipt,
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
import { getCustomer, type CustomerDetail } from '../queries';
import { CustomerEditForm } from './edit-form';

export const dynamic = 'force-dynamic';

/** 0..1 oranı yüzde metnine çevirir. */
function ratePct(rate: number): string {
  return `%${Math.round(rate * 100)}`;
}

const ABUSE_THRESHOLD = 0.3;

/**
 * Değişim talebi durumu → rozet (onaylı=success, garanti-dışı/bilgi=warning,
 * reddedildi=destructive). Paylaşılan StatusBadge bu statüleri bilmediği için
 * (ve o dosyaya dokunulamadığı için) yerel eşleme.
 */
const REPLACEMENT_STATUS: Record<
  string,
  { variant: 'neutral' | 'warning' | 'success' | 'danger'; label: string }
> = {
  open: { variant: 'warning', label: 'açık' },
  info_requested: { variant: 'warning', label: 'bilgi istendi' },
  approved: { variant: 'success', label: 'onaylandı' },
  rejected: { variant: 'danger', label: 'reddedildi' },
};

function ReplacementStatusBadge({ status }: { status: string }) {
  const meta = REPLACEMENT_STATUS[status] ?? { variant: 'neutral' as const, label: status };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ email: string }>;
}) {
  const { email: rawEmail } = await params;
  const email = decodeURIComponent(rawEmail);

  let data: CustomerDetail | null = null;
  let error: string | null = null;
  try {
    data = await getCustomer(email);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/customers">
            <ArrowLeft /> Müşteriler
          </Link>
        </Button>
        <Card className="p-6">
          <p className="text-sm text-destructive">Müşteri yüklenemedi: {error}</p>
        </Card>
      </div>
    );
  }

  const { stats, orders, replacements, tags, notes } = data;
  const abusive = stats.replacementRate > ABUSE_THRESHOLD;

  return (
    <div className="space-y-6">
      {/* Başlık */}
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/customers">
            <ArrowLeft /> Müşteriler
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{data.email}</h1>
            {tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {tags.map((t) => (
                  <Badge key={t} variant="outline">
                    {t}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          {abusive && (
            <Badge variant="warning" className="mt-1">
              <ShieldAlert />
              Yüksek değişim oranı
            </Badge>
          )}
        </div>
      </div>

      {/* Özet istatistikler */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Sipariş" value={stats.orderCount} icon={ShoppingCart} tone="neutral" />
        <StatTile label="Atama" value={stats.assignmentCount} icon={KeyRound} tone="accent" />
        <StatTile label="Değişim" value={stats.replacementCount} icon={RefreshCw} tone="neutral" />
        <StatTile
          label="Değişim Oranı"
          value={ratePct(stats.replacementRate)}
          icon={ShieldAlert}
          tone={abusive ? 'warning' : 'neutral'}
          hint={abusive ? 'suistimal işareti' : undefined}
        />
      </div>

      {/* Etiket/Not düzenleme */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Tags className="size-4 text-muted-foreground" /> Etiketler & Not
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CustomerEditForm email={data.email} tags={tags} notes={notes} />
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Siparişler */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Receipt className="size-4 text-muted-foreground" /> Siparişler
            </CardTitle>
          </CardHeader>
          <CardContent className={orders.length === 0 ? '' : 'p-0'}>
            {orders.length === 0 ? (
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
                  {orders.map((o) => (
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

        {/* Değişim talepleri */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="size-4 text-muted-foreground" /> Değişim Talepleri
            </CardTitle>
          </CardHeader>
          <CardContent className={replacements.length === 0 ? '' : 'p-0'}>
            {replacements.length === 0 ? (
              <EmptyState icon={RefreshCw} title="Değişim talebi yok" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Sebep</TableHead>
                    <TableHead>Durum</TableHead>
                    <TableHead>Tarih</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {replacements.map((r) => (
                    <TableRow key={r.id} className="align-top">
                      <TableCell className="max-w-xs text-foreground">
                        <span className="line-clamp-2">{r.reason}</span>
                      </TableCell>
                      <TableCell>
                        <ReplacementStatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {new Date(r.createdAt).toLocaleDateString('tr-TR', { dateStyle: 'short' })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
