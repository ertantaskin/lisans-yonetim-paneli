import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Globe,
  Users,
  ShoppingCart,
  KeyRound,
  RefreshCw,
  ShieldAlert,
  Tags,
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
import { RiskBadge } from '../../../components/risk-badge';
import { getCustomer, type CustomerDetail } from '../queries';
import { CustomerEditForm } from './edit-form';

export const dynamic = 'force-dynamic';

/** 0..1 oranı yüzde metnine çevirir. */
function ratePct(rate: number): string {
  return `%${Math.round(rate * 100)}`;
}

const ABUSE_THRESHOLD = 0.3;

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
          {/* min-w-0: flex öğesinin otomatik minimum boyutu kapatılmazsa dar ekranda küçülemez.
              break-all: e-posta kırılmaz tek token; `break-words` (overflow-wrap) min-content
              boyutunu ETKİLEMEZ, dolayısıyla taşmayı durdurmaz — word-break gerekir. */}
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
              <Users className="size-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 break-all" title={data.email}>
                {data.email}
              </span>
            </h1>
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

      {/* Özet istatistikler + advisory risk skoru (§8/§9) tek satırda */}
      <div className="flex flex-wrap items-center gap-3">
        <StatStrip
          className="flex-1"
          items={[
            { icon: ShoppingCart, label: 'Sipariş', value: stats.orderCount },
            { icon: KeyRound, label: 'Atama', value: stats.assignmentCount },
            { icon: RefreshCw, label: 'Değişim', value: stats.replacementCount },
            {
              icon: ShieldAlert,
              label: 'Değişim Oranı',
              value: ratePct(stats.replacementRate),
              tone: abusive ? 'warning' : undefined,
              hint: abusive ? 'suistimal işareti' : undefined,
            },
          ]}
        />
        {/* Advisory risk skoru — salt bilgi, otomatik eylem yok */}
        <RiskBadge email={data.email} />
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

      <div className="grid gap-6 [&>*]:min-w-0 md:grid-cols-2">
        {/* Siparişler */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShoppingCart className="size-4 text-muted-foreground" /> Siparişler
            </CardTitle>
          </CardHeader>
          <CardContent className={orders.length === 0 ? '' : 'p-0'}>
            {orders.length === 0 ? (
              <EmptyState icon={ShoppingCart} title="Sipariş yok" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Sipariş No</TableHead>
                    <TableHead>Site</TableHead>
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
                      {/* ÇOK MAĞAZA: sipariş no'ları mağazalara göre çakışabilir — hangi
                          mağazadan geldiği burada da görünmeli (liste ekranıyla simetri).
                          Alan eski API'de yoksa uydurma değer değil '—' basılır. */}
                      <TableCell className="text-muted-foreground">
                        {o.siteDomain ? (
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            <Globe className="size-3.5 shrink-0" aria-hidden />
                            {o.siteDomain}
                          </span>
                        ) : (
                          '—'
                        )}
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
                    <TableHead>Sipariş</TableHead>
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
                      {/* Talep artık TIKLANABİLİR: siparişe git (Siparişler kartındaki "Aç" ile
                          simetri). Sipariş çözülemiyorsa /support'a düşülür — operatör talebi
                          metinle aramak zorunda kalmasın. */}
                      <TableCell>
                        {r.orderId ? (
                          <Link
                            href={`/orders/${r.orderId}`}
                            className="tabular-nums text-primary underline-offset-2 hover:underline"
                            title="Sipariş detayına git"
                          >
                            {r.remoteOrderId ? `#${r.remoteOrderId}` : 'Siparişi aç'}
                          </Link>
                        ) : (
                          <Link
                            href="/support"
                            className="text-primary underline-offset-2 hover:underline"
                            title="Destek kuyruğunu aç"
                          >
                            Destek
                          </Link>
                        )}
                        {r.siteDomain && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {r.siteDomain}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
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
