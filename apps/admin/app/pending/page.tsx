import Link from 'next/link';
import { Inbox, Clock3, Boxes, PackageX, ArrowRight, Link2, Unlink } from 'lucide-react';
import { apiGet, type OrderRow, type ProductRow } from '../../lib/api';
import { getDashboard, type DashboardSummary } from '../dashboard/queries';
import { PageHeader, EmptyState } from '../../components/ui/page-header';
import { StatTile } from '../../components/ui/stat-tile';
import { Card } from '../../components/ui/card';
import { Badge, StatusBadge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../components/ui/table';
import { cn, relativeTime, waitTone } from '../../lib/utils';

export const dynamic = 'force-dynamic';

const waitColor: Record<string, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
  muted: 'text-muted-foreground',
};

/**
 * `/v1/admin/pending` satırı. `hasUnmappedLine` API sözleşmesine SONRADAN eklendi ve
 * `lib/api.ts`'teki paylaşılan `OrderRow` tipinde YOK (o tip başka ekranlarca da kullanılıyor).
 * api ve admin ayrı imajlar olduğu için alan hiç gelmeyebilir → burada OPSİYONEL okunur ve
 * `=== true` ile savunmacı değerlendirilir (undefined ⇒ işaret çizilmez, uydurma alarm yok).
 */
type PendingOrderRow = OrderRow & { hasUnmappedLine?: boolean };

/**
 * Siparişin en az bir kalemi panel ürününe BAĞLI DEĞİL mi?
 *
 * İki kaynak birleştirilir çünkü ikisi FARKLI durumları yakalar:
 *  • `status === 'unmapped'` → siparişin HİÇBİR kalemi çözülememiş (eski/tekil durum),
 *  • `hasUnmappedLine`       → çok kalemli siparişte durum 'pending'/'partial' görünürken
 *                              yalnız BAZI kalemler eşlemesiz (asıl operatör şikâyeti buydu:
 *                              rozet "Bekliyor" diyor, sipariş aslında eşleme bekliyor).
 */
function needsMapping(o: PendingOrderRow): boolean {
  return o.status === 'unmapped' || o.hasUnmappedLine === true;
}

/**
 * Bekleyen Teslimatlar — teslim edilmemiş her siparişin TEK toplanma noktası.
 *
 * Üç farklı bekleme nedeni aynı listede durur (operatörün "sipariş geldi ama panelde
 * hiçbir yerde göremiyorum" şikâyeti buradan doğmuştu):
 *  • `pending`  → stok bekliyor
 *  • `partial`  → kısmen teslim edildi, kalanı bekliyor
 *  • eşlemesiz kalem → mağaza ürünü panel ürününe EŞLENMEMİŞ → teslimat motoru satıra hiç
 *                 dokunamaz. Tek çözümü elle eşleme (§3: otomatik eşleştirme YOK).
 *
 * Eşleme bekleyen siparişler listenin BAŞINA alınır ve uyarı tonuyla işaretlenir — bekleme
 * süresi ne olursa olsun ilk görülmesi gereken iş odur.
 *
 * SAYAÇLAR LİSTEDEN HESAPLANMAZ: liste sunucuda kırpılır (en yeni N kayıt), dolayısıyla
 * listeden sayılan toplam "gerçek toplam" değildir. Sipariş/satır sayaçları genel-bakış
 * özetinden (tüm kayıtları kapsar) okunur; sayı listeyle uyuşmuyorsa dürüst bir not düşülür.
 */
export default async function DashboardPage() {
  // Üç çekim BAĞIMSIZ: özet düşse bile tablo çizilir, tablo düşse bile hata açıkça yazılır.
  const [ordersRes, productsRes, summaryRes] = await Promise.allSettled([
    apiGet<PendingOrderRow[]>('/v1/admin/pending'),
    apiGet<ProductRow[]>('/v1/admin/products'),
    getDashboard(),
  ]);

  const orders: PendingOrderRow[] = ordersRes.status === 'fulfilled' ? (ordersRes.value ?? []) : [];
  const products: ProductRow[] = productsRes.status === 'fulfilled' ? (productsRes.value ?? []) : [];
  const summary: DashboardSummary | null = summaryRes.status === 'fulfilled' ? summaryRes.value : null;

  const error =
    ordersRes.status === 'rejected'
      ? ordersRes.reason instanceof Error
        ? ordersRes.reason.message
        : 'Bağlantı hatası'
      : null;

  // Sayaç okuma — SAVUNMACI: alan gelmemişse (eski API) `null` = "veri yok", 0 ile karışmaz.
  const readCount = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  /**
   * Eşleme bekleyen sipariş sayısı = en az bir eşlemesiz AKTİF satırı olan sipariş
   * (siparişin bütünüyle eşlemesiz olması GEREKMEZ). Tüm kayıtları kapsar; listenin
   * kırpılmasından etkilenmez.
   */
  const unmappedOrders = summary ? readCount(summary.unmappedOrders) : null;
  /** Teslim bekleyen sipariş SATIRI (pending + partial) — yine tüm kayıtlar üzerinden. */
  const pendingLines = summary ? readCount(summary.pendingLines) : null;

  const productsOk = productsRes.status === 'fulfilled';
  const outOfStock = products.filter((p) => p.availableStock === 0).length;
  const totalStock = products.reduce((s, p) => s + (p.availableStock || 0), 0);

  // Eşleme bekleyenler önce; kalanlar API'nin verdiği sırayı (tarih azalan) korur — `sort` stabil.
  const rows = [...orders].sort((a, b) => Number(needsMapping(b)) - Number(needsMapping(a)));
  const listedNeedsMapping = rows.filter(needsMapping).length;

  // Sayaç > listede görünen ⇒ liste kırpılmış. Sessizce "hepsi bu kadar" izlenimi VERİLMEZ.
  const listTruncated = unmappedOrders !== null && unmappedOrders > listedNeedsMapping;
  /** Eşleme işi var mı? Sayaç YOKSA listedeki işaretli satırlar da tek başına yeter. */
  const showMappingWork = (unmappedOrders ?? 0) > 0 || listedNeedsMapping > 0;

  return (
    <div>
      <PageHeader
        icon={Inbox}
        title="Bekleyen Teslimatlar"
        description="Stok bekleyen, kısmen teslim edilmiş ve mağaza ürünü panelde eşlenmediği için teslim edilemeyen siparişler. Kısmi—otomatik politikalı siparişler stok girince kendiliğinden tamamlanır; eşleme bekleyen kalemler için önce ürün eşleştirmesi yapmalısınız."
      >
        {showMappingWork && (
          <Button asChild size="sm">
            <Link href="/mappings">
              <Link2 className="size-4" /> Ürün Eşleştirme
            </Link>
          </Button>
        )}
        <Button asChild variant="outline" size="sm">
          <Link href="/stock">
            <Boxes className="size-4" /> Stok Gir
          </Link>
        </Button>
      </PageHeader>

      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <>
          <div
            className={cn(
              'mb-6 grid gap-3 sm:grid-cols-2',
              showMappingWork ? 'lg:grid-cols-5' : 'lg:grid-cols-4',
            )}
          >
            {/* Teslimatı fiilen durduran tek arıza — varsa şeridin BAŞINDA durur. */}
            {showMappingWork && (
              <StatTile
                label="Eşleme bekleyen sipariş"
                // Özet çekilemediyse listeden sayılan (kırpılmış) değere düşülür; not altta.
                value={(unmappedOrders ?? listedNeedsMapping).toLocaleString('tr-TR')}
                icon={Unlink}
                tone="danger"
                hint="kalemleri panel ürününe bağlanmalı"
              />
            )}
            <StatTile
              label="Teslim bekleyen satır"
              value={pendingLines !== null ? pendingLines.toLocaleString('tr-TR') : '—'}
              icon={Clock3}
              tone={pendingLines !== null && pendingLines > 0 ? 'warning' : 'neutral'}
              hint={pendingLines !== null ? 'stok/tamamlama bekliyor' : 'sayaç alınamadı'}
            />
            <StatTile
              label="Listelenen sipariş"
              value={rows.length.toLocaleString('tr-TR')}
              icon={Inbox}
              tone="accent"
              hint={listTruncated ? 'en yeni kayıtlar' : 'tamamlanmamış siparişler'}
            />
            <StatTile
              label="Toplam stok"
              value={productsOk ? totalStock.toLocaleString('tr-TR') : '—'}
              icon={Boxes}
              tone={productsOk ? 'success' : 'neutral'}
              hint={productsOk ? `${products.length} ürün` : 'ürün listesi alınamadı'}
            />
            <StatTile
              label="Stoksuz ürün"
              value={productsOk ? outOfStock.toLocaleString('tr-TR') : '—'}
              icon={PackageX}
              tone={!productsOk ? 'neutral' : outOfStock > 0 ? 'danger' : 'success'}
              hint={!productsOk ? 'ürün listesi alınamadı' : outOfStock > 0 ? 'stok girişi bekliyor' : 'hepsi stokta'}
            />
          </div>

          {/*
            Dürüstlük notu: sayaçlar TÜM kayıtları, tablo yalnız en yeni N kaydı kapsar.
            Fark varsa sessiz kalmak "hepsi bu kadar" yanılgısı üretirdi.
          */}
          {(listTruncated || unmappedOrders === null) && (
            <p className="mb-3 text-xs text-muted-foreground">
              {/*
                `unmappedOrders === null` iki durumu birden kapsar: özet HİÇ gelmedi ya da
                geldi ama alan yok (api/admin sürüm sapması). İkisinde de ekrandaki değer
                LİSTEDEN türetilmiştir → "genel toplam" sanılmasın diye açıkça söylenir.
              */}
              {unmappedOrders !== null ? (
                <>
                  Sayaçlar tüm kayıtları kapsar; tabloda en yeni{' '}
                  <strong className="tabular-nums">{rows.length}</strong> sipariş gösteriliyor
                  (eşleme bekleyen <strong className="tabular-nums">{unmappedOrders}</strong>{' '}
                  siparişin <strong className="tabular-nums">{listedNeedsMapping}</strong> tanesi
                  listede). Tamamı için Ürün Eşleştirme ekranındaki bekleyen satır panelini kullanın.
                </>
              ) : (
                <>
                  Özet sayaçlar alınamadı — aşağıdaki değerler yalnız listelenen{' '}
                  <strong className="tabular-nums">{rows.length}</strong> siparişi kapsar, genel
                  toplam olarak okumayın.
                </>
              )}
            </p>
          )}

          <Card>
            {rows.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="Bekleyen teslimat yok"
                description="Tüm siparişler teslim edildi; eşleştirme bekleyen sipariş de yok. Yeni sipariş geldiğinde burada görünür."
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
                  {rows.map((o) => {
                    const mappingNeeded = needsMapping(o);
                    // Durum rozeti 'unmapped' DEĞİLKEN de eşleme gerekebilir (çok kalemli sipariş):
                    // bu ayrım metni belirler — "hiçbiri bağlı değil" vs "bazı kalemler bağlı değil".
                    const partiallyUnmapped = mappingNeeded && o.status !== 'unmapped';
                    return (
                      <TableRow
                        key={o.id}
                        className={cn(
                          mappingNeeded &&
                            'bg-[color-mix(in_oklch,var(--destructive)_7%,transparent)] hover:bg-[color-mix(in_oklch,var(--destructive)_12%,transparent)]',
                        )}
                      >
                        <TableCell className="font-medium text-foreground">{o.remoteOrderId}</TableCell>
                        <TableCell className="text-foreground/80">{o.customerEmail}</TableCell>
                        <TableCell>
                          <span className="flex flex-wrap items-center gap-1.5">
                            {/* StatusBadge 'unmapped' için zaten "Eşlenmemiş" + uyarı rengi üretir. */}
                            <StatusBadge status={o.status} />
                            {/* Durum rozeti bunu söylemiyorsa AÇIK ikinci işaret. */}
                            {partiallyUnmapped && (
                              <Badge variant="danger">
                                <Unlink /> Eşleme gerekiyor
                              </Badge>
                            )}
                          </span>
                          {mappingNeeded && (
                            <span className="mt-0.5 block text-[11px] text-destructive">
                              {partiallyUnmapped
                                ? 'Bazı kalemlerin mağaza ürünü panel ürününe bağlı değil'
                                : 'Mağaza ürünü panel ürününe bağlı değil'}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className={`text-xs font-medium ${waitColor[waitTone(o.createdAt)]}`}>
                          {relativeTime(o.createdAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {/* Eşleme bekleyen siparişte asıl iş eşleme ekranında — açık ve birincil link. */}
                            {mappingNeeded && (
                              <Button asChild variant="outline" size="sm">
                                <Link href="/mappings">
                                  <Link2 className="size-3.5" /> Eşleştir
                                </Link>
                              </Button>
                            )}
                            <Button asChild variant="ghost" size="sm">
                              <Link href={`/orders/${o.id}`}>
                                {mappingNeeded ? 'Siparişi aç' : 'İşle'}{' '}
                                <ArrowRight className="size-3.5" />
                              </Link>
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
