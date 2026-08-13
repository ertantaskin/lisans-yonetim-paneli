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
  TrendingDown,
  Truck,
  ClipboardList,
  Wrench,
  Upload,
  PackagePlus,
  Link2,
  Pencil,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { StatStrip } from '../../../components/ui/stat-tile';
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
import { formatDate } from '../../../lib/utils';
import {
  productTypeSummary,
  fulfillmentPolicyLabel,
  stockStateLabel,
  supplyStatusLabel,
  adjustmentActionLabel,
} from '../../../lib/labels';
import { getProductDetail, type ProductDetail } from './queries';
import { StockAdjustForm } from './stock-adjust-form';
import { ProductEditSheet } from '../../../components/product-edit-sheet';
import { MappingsManager } from '../../../components/mappings-manager';
import { LicenseItemsTable } from '../../../components/inventory/license-items-table';

export const dynamic = 'force-dynamic';

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
  return <Badge variant={STATUS_VARIANT[status] ?? 'neutral'}>{supplyStatusLabel(status)}</Badge>;
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
  /**
   * ?batchId= — ESKİ derin bağlantı biçimi. Stok girişi bu sayfadan `/stock/import` ekranına
   * taşındı; eski yer imleri/linkler kaybolmasın diye parti kimliği ORADAKİ forma taşınır
   * (aşağıdaki "Stok Girişi" düğmesinin hedefine `&batch=` olarak eklenir).
   */
  const { batchId } = await searchParams;
  const importHref = `/stock/import?product=${id}${batchId ? `&batch=${batchId}` : ''}`;

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
          <div className="flex items-start gap-3">
            <span
              className="hidden size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground shadow-sm sm:flex"
              aria-hidden
            >
              <Package className="size-5" />
            </span>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">{product.name}</h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground">
                  <Package className="size-3.5 text-muted-foreground" />
                  {product.sku}
                </span>
                <span>{productTypeSummary(product)}</span>
                <span aria-hidden>·</span>
                <span>{fulfillmentPolicyLabel(product.fulfillmentPolicy)}</span>
              </div>
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

      {/* Stok durumu — tek satırlık ince özet şeridi (StatTile ızgarası yerine) */}
      <div className="space-y-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Boxes className="size-4 text-muted-foreground" aria-hidden /> Stok durumu
        </h2>
        <StatStrip
          items={[
            {
              icon: Boxes,
              label: stockStateLabel('available'),
              value: stock.available,
              hint: 'kalan kapasite',
              tone: stock.available === 0 ? 'danger' : lowStock ? 'warning' : 'success',
            },
            { icon: KeyRound, label: stockStateLabel('assigned'), value: stock.assigned },
            { icon: Ban, label: stockStateLabel('revoked'), value: stock.revoked },
            { icon: Clock, label: stockStateLabel('expired'), value: stock.expired },
            { icon: ShieldAlert, label: stockStateLabel('voided'), value: stock.voided },
          ]}
        />
      </div>

      {/* Satış & tükenme — ince özet şeridi */}
      <div className="space-y-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <TrendingDown className="size-4 text-muted-foreground" aria-hidden /> Satış & tükenme
        </h2>
        <StatStrip
          items={[
            { icon: TrendingUp, label: '7 günlük satış', value: velocity.sold7d },
            { icon: TrendingUp, label: '30 günlük satış', value: velocity.sold30d },
            {
              icon: TrendingUp,
              label: 'Günlük ortalama',
              value: velocity.dailyRate,
              hint: 'son 30 gün / 30',
            },
            {
              icon: Clock,
              label: 'Tahmini tükenme',
              value: velocity.daysRemaining != null ? `${velocity.daysRemaining} gün` : '—',
              tone:
                velocity.daysRemaining != null && velocity.daysRemaining <= 7 ? 'warning' : 'default',
              hint: velocity.daysRemaining == null ? 'tahmin edilemez' : undefined,
            },
          ]}
        />
      </div>

      {/* ── İki kolon: sol (geniş) ana çalışma; sağ (dar) referans + geçmiş ── */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* SOL (geniş) — ana çalışma alanı: içe aktar + eşlemeler */}
        <div className="space-y-4 lg:col-span-2">
          {/*
            Key/Stok girişi ARTIK BURADA DEĞİL: kendi ekranına (`/stock/import`) taşındı — o
            ekran menüden de bulunabiliyor ve doğrulama/önizleme adımlarına yer açıyor. Burada
            yalnız bağlamsal kısayol kalır: ürün (ve varsa parti) hedef ekranda ön-seçili gelir.
          */}
          <Card>
            <CardHeader>
              <CardTitle icon={Upload}>Stok Girişi</CardTitle>
              <CardDescription>
                Bu ürüne yeni anahtar/hesap eklemek <strong>Stok Girişi</strong> ekranında yapılır —
                ürün ön-seçili açılır. İki yol vardır: <strong>hızlı giriş</strong> (yalnız anahtarlar;
                maliyet/tedarikçi izi tutulmaz) veya <strong>tedarikli giriş</strong> (tedarikçi + alım
                tarihi + birim maliyet → parti ve satın alma emri aynı adımda açılır). Girmeden önce
                &quot;Önizle (kuru çalıştır)&quot; ile hiçbir şey kaydetmeden doğrulayabilirsiniz.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild>
                <Link href={importHref}>
                  <PackagePlus /> Bu ürüne stok gir
                </Link>
              </Button>
              {batchId && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Seçtiğiniz parti Stok Girişi ekranına taşınır.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Site eşlemeleri — bu ürünün eşlemeleri (mağaza → panel); katalogdan adıyla seç + aç-kapa + kaldır */}
          <Card>
            <CardHeader>
              <CardTitle icon={Link2}>Site Eşlemeleri</CardTitle>
              <CardDescription>
                Bu ürünü mağazadaki ürün/varyasyona bağlayın: siteyi seçin, mağaza ürününü
                <strong> adıyla</strong> seçin (ID yazmanıza gerek yok). Sipariş bu eşleme ile teslim edilir.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <MappingsManager productId={product.id} sites={sites} mappings={data.mappings} />
            </CardContent>
          </Card>
        </div>

        {/* SAĞ (dar) rail — referans: partiler + satın alma emirleri + stok düzeltme (form + geçmişi) */}
        <div className="space-y-4">
          {/* Partiler */}
          <Card>
            <CardHeader>
              <CardTitle icon={Package}>Partiler</CardTitle>
              <CardDescription>
                Bu ürünün stok partileri — hangi anahtarlar kimden, ne zaman geldi. Parti,{' '}
                <strong>Stok Girişi</strong>&apos;nde tedarikçi/maliyet girildiğinde ya da bir satın
                alma emri teslim alındığında oluşur; geri çekme (recall) bu partiler üzerinden yapılır.
              </CardDescription>
            </CardHeader>
            <CardContent className={batches.length === 0 ? '' : 'overflow-x-auto p-0'}>
              {batches.length === 0 ? (
                <EmptyState
                  icon={Package}
                  title="Parti yok"
                  description="Bu ürünün anahtarları bir partiye bağlı değil (ya hiç stok girilmedi ya da partisiz/hızlı giriş yapıldı). Maliyet ve tedarikçi izi için stok girişinde tedarikçi + alım tarihi + birim maliyet doldurun."
                >
                  <Button asChild size="sm" variant="outline">
                    <Link href={importHref}>
                      <PackagePlus /> Stok Girişi
                    </Link>
                  </Button>
                </EmptyState>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Etiket</TableHead>
                      <TableHead>Durum</TableHead>
                      <TableHead className="text-right">Alınan</TableHead>
                      <TableHead className="text-right">Aksiyon</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {batches.map((b) => (
                      <TableRow key={b.id}>
                        <TableCell className="font-medium text-foreground">
                          {b.label}
                          {/*
                            NOT: "Otomatik" rozeti (stok girişinden türemiş parti/emir) BURADA
                            gösterilemiyor — `products/:id/detail` ucu parti/emir `notes` alanını
                            döndürmüyor, işaret ise `isAutoReceipt(notes)` ile okunuyor. Ham
                            `[oto-giris]` öneki de bu ekranda hiç basılmaz (notes render edilmiyor),
                            yani kullanıcıya sızan bir şey yok. Rozet istenirse önce API yanıtına
                            `notes` eklenmeli (kontrat değişikliği) — /batches ve /purchase-orders
                            listelerinde rozet zaten var.
                          */}
                          {/* Tedarikçi + teslim tarihi: "bu parti kimden, ne zaman geldi" ekranda. */}
                          <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                            {[b.supplierName ?? null, b.receivedAt ? formatDate(b.receivedAt, false) : null]
                              .filter(Boolean)
                              .join(' · ') || '—'}
                          </span>
                        </TableCell>
                        <TableCell>
                          <StateBadge status={b.status} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {b.qtyReceived}
                        </TableCell>
                        <TableCell className="text-right">
                          {/* Parti için ayrı detay rotası YOK → yapılabilir tek bağlamsal iş:
                              bu partiye stok girmek (Stok Girişi ekranını ürün + parti ile
                              ön-doldurur; eskiden aynı sayfaya ?batchId= ile dönüyordu). */}
                          {b.status === 'active' ? (
                            <Button asChild variant="ghost" size="sm">
                              <Link href={`/stock/import?product=${product.id}&batch=${b.id}`}>
                                Stok gir
                              </Link>
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
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
              <CardTitle icon={Truck}>Satın Alma Emirleri</CardTitle>
              <CardDescription>
                Bu ürün için açık/kapalı tedarik siparişleri. Emri önceden verip malı sonra (ya da
                parça parça) alıyorsanız buradan takip edilir; tedarikli stok girişinde panel emri
                zaten teslim alınmış olarak kendisi açar.
              </CardDescription>
            </CardHeader>
            <CardContent className={purchaseOrders.length === 0 ? '' : 'overflow-x-auto p-0'}>
              {purchaseOrders.length === 0 ? (
                <EmptyState
                  icon={Truck}
                  title="Satın alma emri yok"
                  description="Bu ürün için tedarik emri kaydı yok. Beklenen bir teslimat varsa Satın Alma ekranından emir açabilirsiniz."
                >
                  <Button asChild size="sm" variant="outline">
                    <Link href="/purchase-orders">
                      <Truck /> Satın Alma
                    </Link>
                  </Button>
                </EmptyState>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Tedarikçi / Durum</TableHead>
                      <TableHead className="text-right">Sipariş</TableHead>
                      <TableHead className="text-right">Alınan</TableHead>
                      <TableHead>ETA</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {purchaseOrders.map((po) => (
                      <TableRow key={po.id}>
                        <TableCell>
                          {/* "Stok bitiyor, açık emir kimde?" — emir satırı artık tedarikçiyi
                              yazar ve emrin detayına tıklanır (eskiden ikisi de yoktu). */}
                          <Link
                            href={`/purchase-orders/${po.id}`}
                            className="font-medium text-foreground underline-offset-4 hover:underline"
                          >
                            {po.supplierName ?? 'Satın alma emri'}
                          </Link>
                          <span className="mt-1 block">
                            <StateBadge status={po.status} />
                          </span>
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

          {/* Stok düzeltme ekle (manuel, sebepli — audit'e düşer) + hemen altında geçmişi */}
          <Card>
            <CardHeader>
              <CardTitle icon={Wrench}>Stok Düzeltme Ekle</CardTitle>
              <CardDescription>
                Manuel stok düzeltmesi (void/hasar/geri çekme) — sebep zorunlu, denetime yazılır.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <StockAdjustForm productId={product.id} />
            </CardContent>
          </Card>

          {/* Stok düzeltmeleri (geçmiş — form ile eşli) */}
          <Card>
            <CardHeader>
              <CardTitle icon={ClipboardList}>Stok Düzeltmeleri</CardTitle>
              <CardDescription>
                Geçmiş manuel düzeltme kayıtları — kimin yaptığı ve stokun gerçekten değişip
                değişmediği ile birlikte. Geçersiz kılınan anahtarlar{' '}
                <Link
                  href="/quarantine?status=voided"
                  className="text-foreground underline underline-offset-4"
                >
                  Karantina
                </Link>{' '}
                ekranında listelenir.
              </CardDescription>
            </CardHeader>
            <CardContent className={adjustments.length === 0 ? '' : 'overflow-x-auto p-0'}>
              {adjustments.length === 0 ? (
                <EmptyState
                  icon={ClipboardList}
                  title="Düzeltme kaydı yok"
                  description="Henüz manuel düzeltme yapılmadı."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Aksiyon</TableHead>
                      <TableHead className="text-right">Adet</TableHead>
                      <TableHead>Sebep</TableHead>
                      <TableHead>Yapan</TableHead>
                      <TableHead>Tarih</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {adjustments.map((a) => {
                      // Stok GERÇEKTEN değişti mi: yalnız kalem-kapsamlı void/damage bir
                      // license_items satırını 'voided' yapar; kalemsiz kayıt sadece defterdir.
                      const touchedStock =
                        Boolean(a.licenseItemId) && (a.action === 'void' || a.action === 'damage');
                      return (
                        <TableRow key={a.id} className="align-top">
                          <TableCell>
                            <Badge variant="outline">{adjustmentActionLabel(a.action)}</Badge>
                            <span
                              className={`mt-1 block text-xs ${
                                touchedStock ? 'text-muted-foreground' : 'text-warning'
                              }`}
                            >
                              {touchedStock ? 'Stoktan düşüldü' : 'Yalnız kayıt — stok değişmedi'}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {a.qty}
                          </TableCell>
                          {/* Kırpılan sebebin TAMAMI title'da (eski hâlinde okumanın yolu yoktu). */}
                          <TableCell className="text-foreground">
                            <span className="line-clamp-2" title={a.reason}>
                              {a.reason}
                            </span>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {/* Alan eski api imajında gelmeyebilir → uydurma yerine '—'. */}
                            <span className="line-clamp-2" title={a.actor ?? undefined}>
                              {a.actor || '—'}
                            </span>
                          </TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {dtFmt(a.createdAt)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Lisans envanteri — TAM GENİŞLİK (kolon çok: lisans + durum + kapasite + teslimat).
          Konum bilinçli: önce stok girilir/eşlenir (üstteki kartlar), sonra sonucu burada görülür. */}
      {/* id: /batches satır menüsünden "ürünün lisans envanteri" derin bağlantısı buraya iner. */}
      <Card id="lisans-envanteri" className="scroll-mt-20">
        <CardHeader>
          <CardTitle icon={KeyRound}>Lisans Envanteri</CardTitle>
          <CardDescription>
            Bu ürüne ait tüm lisans/hesap kalemleri — arama, filtreleme, tek tek düzeltme ve
            teslim edilmiş kalemlerin sipariş bağlantısı.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LicenseItemsTable productId={product.id} payloadSchema={product.payloadSchema} />
        </CardContent>
      </Card>
    </div>
  );
}
