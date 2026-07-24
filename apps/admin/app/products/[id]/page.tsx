import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Package,
  KeyRound,
  ShieldAlert,
  Ban,
  Clock,
  Boxes,
  TrendingUp,
  Truck,
  ClipboardList,
  Wrench,
  Upload,
  Link2,
  Pencil,
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
import { ApiError, apiGet, type SiteRow } from '../../../lib/api';
import { getProductDetail, type ProductDetail } from './queries';
import { StockAdjustForm } from './stock-adjust-form';
import { ProductEditSheet } from '../../../components/product-edit-sheet';
import { ImportStockForm } from '../../../components/import-stock-form';
import { MappingsManager } from '../../../components/mappings-manager';

export const dynamic = 'force-dynamic';

/** Ürün tip etiketi: kind + (multi ise) kapasite + geçerlilik (products-table ile aynı dil). */
function typeLabel(p: ProductDetail['product']): string {
  const parts: string[] = [p.kind];
  if (p.usageMode === 'multi') parts.push(`MAK×${p.maxUses ?? '?'}`);
  if (p.validityDays) parts.push(`${p.validityDays}g`);
  return parts.join(' · ');
}

/** Parti/PO durumu → rozet varyantı (StatusBadge bu statüleri bilmez → yerel eşleme). */
const STATUS_VARIANT: Record<string, 'neutral' | 'warning' | 'success' | 'danger' | 'outline'> = {
  active: 'success',
  received: 'success',
  ordered: 'warning',
  partial: 'warning',
  draft: 'outline',
  recalled: 'danger',
  voided: 'danger',
  cancelled: 'danger',
};

function StateBadge({ status }: { status: string }) {
  return <Badge variant={STATUS_VARIANT[status] ?? 'neutral'}>{status}</Badge>;
}

const dtFmt = (iso: string) =>
  new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });

export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ batchId?: string }>;
}) {
  const { id } = await params;
  // ?batchId= — /batches "Bu partiye stok gir" derin bağlantısı import formunu ön-doldurur.
  const { batchId } = await searchParams;

  let data: ProductDetail | null = null;
  let sites: SiteRow[] = [];
  let error: string | null = null;
  try {
    // Detay + siteler paralel (siteler eşleme formunun site seçimi için).
    [data, sites] = await Promise.all([
      getProductDetail(id),
      apiGet<SiteRow[]>('/v1/admin/sites'),
    ]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/stock">
            <ArrowLeft /> Stok & Ürünler
          </Link>
        </Button>
        <Card className="p-6">
          <p className="text-sm text-destructive">Ürün yüklenemedi: {error}</p>
        </Card>
      </div>
    );
  }

  const { product, stock, batches, purchaseOrders, velocity, adjustments } = data;

  // Düşük stok işareti (§12): eşik tanımlı ve kalan available <= eşik.
  const lowStock =
    product.lowStockThreshold != null && stock.available <= product.lowStockThreshold;

  return (
    <div className="space-y-6">
      {/* Başlık */}
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/stock">
            <ArrowLeft /> Stok & Ürünler
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{product.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="font-mono text-xs">{product.sku}</span>
              <span aria-hidden>·</span>
              <span>{typeLabel(product)}</span>
              <span aria-hidden>·</span>
              <span>{product.fulfillmentPolicy}</span>
            </div>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {lowStock && (
              <Badge variant="warning">
                <ShieldAlert />
                Düşük stok (eşik {product.lowStockThreshold})
              </Badge>
            )}
            {/* Ürün-merkezli hub: düzenleme artık burada (paylaşımlı edit sheet). */}
            <ProductEditSheet
              product={{ ...product, availableStock: stock.available }}
              trigger={
                <Button variant="outline" size="sm">
                  <Pencil /> Düzenle
                </Button>
              }
            />
          </div>
        </div>
      </div>

      {/* Stok kırılımı */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label="Available"
          value={stock.available}
          icon={Boxes}
          tone={stock.available > 0 ? 'success' : 'danger'}
          hint="kalan kapasite"
        />
        <StatTile label="Assigned" value={stock.assigned} icon={KeyRound} tone="accent" />
        <StatTile label="Revoked" value={stock.revoked} icon={Ban} tone="neutral" />
        <StatTile label="Expired" value={stock.expired} icon={Clock} tone="neutral" />
        <StatTile label="Voided" value={stock.voided} icon={ShieldAlert} tone="neutral" />
      </div>

      {/* Satış hızı */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="7 Gün Satış" value={velocity.sold7d} icon={TrendingUp} tone="neutral" />
        <StatTile label="30 Gün Satış" value={velocity.sold30d} icon={TrendingUp} tone="neutral" />
        <StatTile
          label="Günlük Ort."
          value={velocity.dailyRate}
          icon={TrendingUp}
          tone="neutral"
          hint="son 30 gün / 30"
        />
        <StatTile
          label="Tükenme"
          value={velocity.daysRemaining != null ? `${velocity.daysRemaining} gün` : '—'}
          icon={Clock}
          tone={
            velocity.daysRemaining != null && velocity.daysRemaining <= 7 ? 'warning' : 'neutral'
          }
          hint={velocity.daysRemaining == null ? 'tahmin edilemez' : undefined}
        />
      </div>

      {/* Key/Stok import — ürün-merkezli (ürün SABİT, dropdown yok). ?batchId= ön-doldurur. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="size-4 text-muted-foreground" /> Key / Stok İçe Aktar
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ImportStockForm
            fixedProductId={product.id}
            products={[{ ...product, availableStock: stock.available }]}
            defaultBatchId={batchId}
          />
        </CardContent>
      </Card>

      {/* Site eşlemeleri — yalnız bu ürünün eşlemeleri (Woo → panel), oluştur + aç-kapa */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Link2 className="size-4 text-muted-foreground" /> Site Eşlemeleri
          </CardTitle>
        </CardHeader>
        <CardContent>
          <MappingsManager productId={product.id} sites={sites} mappings={data.mappings} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Partiler */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Package className="size-4 text-muted-foreground" /> Partiler
            </CardTitle>
          </CardHeader>
          <CardContent className={batches.length === 0 ? '' : 'p-0'}>
            {batches.length === 0 ? (
              <EmptyState icon={Package} title="Parti yok" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Etiket</TableHead>
                    <TableHead>Durum</TableHead>
                    <TableHead className="text-right">Alınan</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batches.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="font-medium text-foreground">{b.label}</TableCell>
                      <TableCell>
                        <StateBadge status={b.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {b.qtyReceived}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Satın alma emirleri */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Truck className="size-4 text-muted-foreground" /> Satın Alma Emirleri
            </CardTitle>
          </CardHeader>
          <CardContent className={purchaseOrders.length === 0 ? '' : 'p-0'}>
            {purchaseOrders.length === 0 ? (
              <EmptyState icon={Truck} title="Satın alma emri yok" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Durum</TableHead>
                    <TableHead className="text-right">Sipariş</TableHead>
                    <TableHead className="text-right">Alınan</TableHead>
                    <TableHead>ETA</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {purchaseOrders.map((po) => (
                    <TableRow key={po.id}>
                      <TableCell>
                        <StateBadge status={po.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {po.qtyOrdered}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {po.qtyReceived}
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {po.eta
                          ? new Date(po.eta).toLocaleDateString('tr-TR', { dateStyle: 'short' })
                          : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Stok düzeltme ekle (manuel, sebepli — audit'e düşer) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wrench className="size-4 text-muted-foreground" /> Stok Düzeltme Ekle
          </CardTitle>
        </CardHeader>
        <CardContent>
          <StockAdjustForm productId={product.id} />
        </CardContent>
      </Card>

      {/* Stok düzeltmeleri */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wrench className="size-4 text-muted-foreground" /> Stok Düzeltmeleri
          </CardTitle>
        </CardHeader>
        <CardContent className={adjustments.length === 0 ? '' : 'p-0'}>
          {adjustments.length === 0 ? (
            <EmptyState icon={ClipboardList} title="Düzeltme kaydı yok" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Aksiyon</TableHead>
                  <TableHead className="text-right">Adet</TableHead>
                  <TableHead>Sebep</TableHead>
                  <TableHead>Tarih</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {adjustments.map((a) => (
                  <TableRow key={a.id} className="align-top">
                    <TableCell>
                      <Badge variant="outline">{a.action}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {a.qty}
                    </TableCell>
                    <TableCell className="max-w-md text-foreground">
                      <span className="line-clamp-2">{a.reason}</span>
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {dtFmt(a.createdAt)}
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
