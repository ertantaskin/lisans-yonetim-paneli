import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ClipboardList, Boxes, PackageCheck, CalendarClock, Building2, Coins } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatTile } from '@/components/ui/stat-tile';
import { Button } from '@/components/ui/button';
import { POStatusBadge } from '@/components/purchase-orders-table';
import { POReceiveForm, POUpdateForm } from '@/components/po-detail-forms';
import { getPurchaseOrder, type PurchaseOrderRow } from '../queries';

export const dynamic = 'force-dynamic';

/** ISO → kısa tr-TR tarih. */
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('tr-TR', { dateStyle: 'medium' });
}

/** Kuruş → para birimi metni (ör. 12000 TRY → "120,00 TRY"). */
function fmtCost(cents: number | null, currency: string): string {
  if (cents == null) return '—';
  return `${(cents / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2 })} ${currency}`;
}

export default async function PurchaseOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let po: PurchaseOrderRow | null = null;
  let error: string | null = null;
  try {
    po = await getPurchaseOrder(id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  if (error || !po) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/purchase-orders">
            <ArrowLeft /> Satın Alma Emirleri
          </Link>
        </Button>
        <Card className="p-6">
          <p className="text-sm text-destructive">Emir yüklenemedi: {error}</p>
        </Card>
      </div>
    );
  }

  const remaining = Math.max(0, po.qtyOrdered - po.qtyReceived);

  return (
    <div className="space-y-6">
      {/* Başlık */}
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/purchase-orders">
            <ArrowLeft /> Satın Alma Emirleri
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <ClipboardList className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {po.supplierName}
              </h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="font-mono text-xs text-foreground/70">{po.productSku}</span>{' '}
              {po.productName}
            </p>
          </div>
          <POStatusBadge status={po.status} className="mt-1" />
        </div>
      </div>

      {/* Özet */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Teslim"
          value={`${po.qtyReceived}/${po.qtyOrdered}`}
          icon={PackageCheck}
          tone={remaining === 0 ? 'success' : 'warning'}
          hint={remaining === 0 ? 'tamamlandı' : `kalan ${remaining}`}
        />
        <StatTile label="Birim maliyet" value={fmtCost(po.unitCostCents, po.currency)} icon={Coins} tone="neutral" />
        <StatTile label="ETA" value={fmtDate(po.eta)} icon={CalendarClock} tone="neutral" />
        <StatTile label="Tedarikçi" value={po.supplierName} icon={Building2} tone="accent" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Teslim al */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PackageCheck className="size-4 text-muted-foreground" /> Teslim Al
            </CardTitle>
          </CardHeader>
          <CardContent>
            <POReceiveForm po={po} />
          </CardContent>
        </Card>

        {/* Emir bilgileri + güncelle */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Boxes className="size-4 text-muted-foreground" /> Emir Bilgileri
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Sipariş adedi</dt>
              <dd className="tabular-nums text-foreground">{po.qtyOrdered}</dd>
              <dt className="text-muted-foreground">Teslim alınan</dt>
              <dd className="tabular-nums text-foreground">{po.qtyReceived}</dd>
              <dt className="text-muted-foreground">Sipariş tarihi</dt>
              <dd className="text-foreground">{fmtDate(po.orderedAt)}</dd>
              <dt className="text-muted-foreground">Teslim tarihi</dt>
              <dd className="text-foreground">{fmtDate(po.receivedAt)}</dd>
              <dt className="text-muted-foreground">Oluşturma</dt>
              <dd className="text-foreground">{fmtDate(po.createdAt)}</dd>
            </dl>
            {po.notes && (
              <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-foreground/80">
                {po.notes}
              </p>
            )}
            <div className="border-t border-border pt-4">
              <POUpdateForm po={po} />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
