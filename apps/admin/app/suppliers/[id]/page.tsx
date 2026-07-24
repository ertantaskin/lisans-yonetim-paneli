import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
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
import { StatTile } from '../../../components/ui/stat-tile';
import { Badge } from '../../../components/ui/badge';
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

/**
 * Parti durumu → rozet. Paylaşılan StatusBadge parti statülerini (recalled/voided)
 * bilmediği için yerel eşleme.
 */
const BATCH_STATUS: Record<string, { variant: 'success' | 'warning' | 'danger'; label: string }> = {
  active: { variant: 'success', label: 'aktif' },
  recalled: { variant: 'danger', label: 'geri çekildi' },
  voided: { variant: 'warning', label: 'geçersiz' },
};

function BatchStatusBadge({ status }: { status: string }) {
  const meta = BATCH_STATUS[status] ?? { variant: 'warning' as const, label: status };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

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
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {supplier.name}
              </h1>
              {supplier.active ? (
                <Badge variant="success">aktif</Badge>
              ) : (
                <Badge variant="outline">pasif</Badge>
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

      {/* Özet karne istatistikleri */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Satın Alma Emri" value={data.poCount} icon={ClipboardList} tone="neutral" />
        <StatTile
          label="Açık Emir"
          value={data.openPoCount}
          icon={Package}
          tone={data.openPoCount > 0 ? 'warning' : 'neutral'}
        />
        <StatTile label="Sipariş Edilen" value={data.totalOrdered} icon={Boxes} tone="neutral" />
        <StatTile
          label="Teslim Alınan"
          value={data.totalReceived}
          icon={PackageCheck}
          tone="accent"
        />
        <StatTile
          label="Ort. Tedarik Süresi"
          value={data.avgLeadDays == null ? '—' : `${data.avgLeadDays} gün`}
          icon={Timer}
          tone="neutral"
          hint={data.avgLeadDays == null ? 'veri yok' : undefined}
        />
        <StatTile
          label="Geri-Çekilme Oranı"
          value={ratePct(data.recallRate)}
          icon={RotateCcw}
          tone={highRecall ? 'danger' : 'neutral'}
          hint={highRecall ? 'kalite işareti' : undefined}
        />
        <StatTile
          label="Toplam Maliyet"
          value={
            data.totalCostCents.length === 0 ? (
              '—'
            ) : (
              <div className="space-y-0.5">
                {data.totalCostCents.map((c) => (
                  <div key={c.currency || 'unknown'}>{formatCost(c.cents, c.currency)}</div>
                ))}
              </div>
            )
          }
          icon={Wallet}
          tone="neutral"
          hint={
            data.totalCostCents.length > 1
              ? 'para birimi başına ayrı'
              : 'teslim alınan × birim'
          }
        />
        <StatTile label="Parti" value={batches.length} icon={Layers} tone="neutral" />
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
                      <BatchStatusBadge status={b.status} />
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
