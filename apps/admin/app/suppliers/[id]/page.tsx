import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Truck,
  Package,
  PackageCheck,
  Boxes,
  Timer,
  ClipboardList,
  RotateCcw,
  Wallet,
  Layers,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { StatStrip } from '../../../components/ui/stat-tile';
import { Badge, SupplyStatusBadge } from '../../../components/ui/badge';
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
import { supplyStatusLabel } from '../../../lib/labels';
import { getSupplierScorecard, type SupplierScorecard } from '../queries';

export const dynamic = 'force-dynamic';

/** 0..1 oranı yüzde metnine çevirir. */
function ratePct(rate: number): string {
  return `%${Math.round(rate * 100)}`;
}

/**
 * Kuruş → yerelleştirilmiş tutar. Para birimi PO'dan gelir (karışım BİRLEŞTİRİLMEZ —
 * her para birimi ayrı gösterilir). Geçersiz/boş kod → sembolsüz sayı + ham kod.
 */
function formatCost(cents: number, currency: string): string {
  const code = currency && currency.trim() !== '' ? currency : 'TRY';
  try {
    return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: code }).format(cents / 100);
  } catch {
    const num = new Intl.NumberFormat('tr-TR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
    return `${num} ${currency}`.trim();
  }
}

// Yüksek geri-çekilme oranı işareti (tedarikçi kalite sinyali).
const RECALL_THRESHOLD = 0.1;

export default async function SupplierScorecardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let data: SupplierScorecard | null = null;
  let error: string | null = null;
  try {
    data = await getSupplierScorecard(id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/suppliers">
            <ArrowLeft /> Tedarikçiler
          </Link>
        </Button>
        <Card className="p-6">
          <p className="text-sm text-destructive">Tedarikçi karnesi yüklenemedi: {error}</p>
        </Card>
      </div>
    );
  }

  const { supplier, batches } = data;
  const highRecall = data.recallRate > RECALL_THRESHOLD && batches.length > 0;

  return (
    <div className="space-y-6">
      {/* Başlık */}
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/suppliers">
            <ArrowLeft /> Tedarikçiler
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Truck className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {supplier.name}
              </h1>
              {supplier.active ? (
                <Badge variant="success">Aktif</Badge>
              ) : (
                <Badge variant="neutral">Pasif</Badge>
              )}
            </div>
            {supplier.contact && (
              <p className="mt-1 text-sm text-muted-foreground">{supplier.contact}</p>
            )}
          </div>
          {highRecall && (
            <Badge variant="danger" className="mt-1">
              <RotateCcw />
              Yüksek geri-çekilme
            </Badge>
          )}
        </div>
        {supplier.notes && (
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">{supplier.notes}</p>
        )}
      </div>

      {/* Özet karne istatistikleri — tek satır şerit + para birimi başına maliyet */}
      <div className="space-y-3">
        <StatStrip
          items={[
            { icon: ClipboardList, label: 'Satın Alma Emri', value: data.poCount },
            {
              icon: Package,
              label: 'Açık Emir',
              value: data.openPoCount,
              tone: data.openPoCount > 0 ? 'warning' : undefined,
            },
            { icon: Boxes, label: 'Sipariş Edilen', value: data.totalOrdered },
            { icon: PackageCheck, label: 'Teslim Alınan', value: data.totalReceived },
            {
              icon: Timer,
              label: 'Ort. Tedarik',
              value: data.avgLeadDays == null ? '—' : `${data.avgLeadDays} gün`,
              hint: data.avgLeadDays == null ? 'veri yok' : undefined,
            },
            {
              icon: RotateCcw,
              label: 'Geri-Çekilme',
              value: ratePct(data.recallRate),
              tone: highRecall ? 'danger' : undefined,
              hint: highRecall ? 'kalite işareti' : undefined,
            },
            { icon: Layers, label: 'Parti', value: batches.length },
          ]}
        />
        {data.totalCostCents.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border bg-card px-4 py-2 text-sm">
            <span className="inline-flex items-center gap-1.5">
              <Wallet className="size-4 text-muted-foreground" />
              <span className="text-muted-foreground">Toplam Maliyet</span>
            </span>
            {data.totalCostCents.map((c) => (
              <strong key={c.currency || 'unknown'} className="tabular-nums text-foreground">
                {formatCost(c.cents, c.currency)}
              </strong>
            ))}
            <span className="text-xs text-muted-foreground">
              {data.totalCostCents.length > 1 ? 'para birimi başına ayrı' : 'teslim alınan × birim'}
            </span>
          </div>
        )}
      </div>

      {/* Partiler */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="size-4 text-muted-foreground" /> Partiler
          </CardTitle>
        </CardHeader>
        <CardContent className={batches.length === 0 ? '' : 'p-0'}>
          {batches.length === 0 ? (
            <EmptyState icon={Layers} title="Parti yok" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Etiket</TableHead>
                  <TableHead>Durum</TableHead>
                  <TableHead className="text-right">Adet</TableHead>
                  <TableHead>Tarih</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-medium text-foreground">{b.label}</TableCell>
                    <TableCell>
                      <SupplyStatusBadge status={b.status} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-foreground">
                      {b.qtyReceived}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {new Date(b.createdAt).toLocaleString('tr-TR', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
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
