import Link from 'next/link';
import {
  Inbox,
  Clock3,
  Boxes,
  PackagePlus,
  PackageX,
  ArrowRight,
  Link2,
  Unlink,
  ClipboardCheck,
} from 'lucide-react';
import { apiGet, type OrderRow, type ProductRow } from '../../lib/api';
import { getDashboard, type DashboardSummary } from '../dashboard/queries';
import { PageHeader, EmptyState } from '../../components/ui/page-header';
import { StatTile } from '../../components/ui/stat-tile';
import { Card } from '../../components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { Badge, StatusBadge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../components/ui/table';
import { cn, relativeTime, waitTone } from '../../lib/utils';
import { siteTypeLabel } from '../../lib/labels';

export const dynamic = 'force-dynamic';

const waitColor: Record<string, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
  muted: 'text-muted-foreground',
};

/** Sipariş başına ürün kırılımı (`pending()` → `productSummary`): ürün · eksik adet. */
interface PendingProductSummary {
  productId: string;
  name: string;
  /** Bu üründen kaç lisans eksik (PANEL birimi: qty − fulfilledQty). */
  missing: number;
}

/**
 * `/v1/admin/pending` satırı. `hasUnmappedLine`/`productSummary`/`heldForReview` API
 * sözleşmesine SONRADAN eklendi ve `lib/api.ts`'teki paylaşılan `OrderRow` tipinde YOK
 * (o tip başka ekranlarca da kullanılıyor). api ve admin ayrı imajlar olduğu için alanlar
 * hiç gelmeyebilir → burada OPSİYONEL okunur ve `=== true` / `Array.isArray` ile savunmacı
 * değerlendirilir (undefined ⇒ işaret çizilmez, uydurma alarm/değer yok).
 */
type PendingOrderRow = OrderRow & {
  hasUnmappedLine?: boolean;
  /** §8 dinamik kota: sipariş manuel onay bekliyor — stok girmek bunu TESLİM ETMEZ. */
  heldForReview?: boolean;
  heldReason?: string | null;
  productSummary?: PendingProductSummary[];
};

/**
 * Sipariş güvenlik incelemesinde mi (§8)? Held sipariş `status='pending'` ile kaydedilir —
 * yani kuyrukta sıradan bir "Bekliyor" satırı gibi görünür. Operatör bunu stok beklemesi
 * sanıp ürüne stok girer ama autoComplete held siparişi ATLAR → hiçbir şey olmaz, sipariş
 * kuyrukta çürür. Gerçek eylem /review ekranındadır; bu yüzden held bayrağı ham durumu EZER
 * (canlı akıştaki `orderBadge` ile aynı disiplin).
 */
function isHeld(o: PendingOrderRow): boolean {
  return o.heldForReview === true;
}

/**
 * Satırın ürün kırılımını SAVUNMACI okur: alan gelmemişse (sürüm sapması) ya da beklenen
 * şekilde değilse boş dizi döner → ekran uydurma ürün/adet basmaz, '—' gösterir.
 */
function readProductSummary(o: PendingOrderRow): PendingProductSummary[] {
  if (!Array.isArray(o.productSummary)) return [];
  return o.productSummary.filter(
    (p): p is PendingProductSummary =>
      !!p && typeof p.productId === 'string' && typeof p.name === 'string',
  );
}

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

  // Sıra: (1) eşleme bekleyenler — teslimatı fiilen durduran tek arıza, (2) incelemedekiler —
  // burada stok girmek İŞE YARAMAZ, aksiyon başka ekranda, (3) kalanlar API sırasında (tarih
  // azalan). `sort` stabil olduğu için grup içi tarih sırası korunur.
  const rank = (o: PendingOrderRow) => (needsMapping(o) ? 2 : isHeld(o) ? 1 : 0);
  const rows = [...orders].sort((a, b) => rank(b) - rank(a));
  const listedNeedsMapping = rows.filter(needsMapping).length;
  const listedHeld = rows.filter(isHeld).length;

  /**
   * Ürün bazında "stok bekleyen talep" — listelenen siparişlerin ürün kırılımı toplanır.
   * Operatörün asıl sorusu "neyi stoklayayım": şeritteki her çip doğrudan Stok Girişi
   * ekranını O ÜRÜN ön-seçili açar (tek tık — arada ürün detayına uğramak gerekmez).
   *
   * DÜRÜSTLÜK: kaynak LİSTELENEN satırlardır (sunucu kuyruğu kırpar) → şerit "genel toplam"
   * değildir ve bu ekranda açıkça yazılır. İncelemedeki siparişler talebe DAHİL EDİLMEZ:
   * onlara stok girmek teslimat üretmez (autoComplete held siparişi atlar) → sahte talep olurdu.
   */
  const demandByProduct = new Map<string, { name: string; missing: number; orders: number }>();
  for (const o of rows) {
    if (isHeld(o)) continue;
    for (const p of readProductSummary(o)) {
      const missing = typeof p.missing === 'number' && p.missing > 0 ? p.missing : 0;
      if (missing === 0) continue;
      const cur = demandByProduct.get(p.productId);
      if (cur) {
        cur.missing += missing;
        cur.orders += 1;
      } else {
        demandByProduct.set(p.productId, { name: p.name, missing, orders: 1 });
      }
    }
  }
  const demand = [...demandByProduct.entries()]
    .map(([productId, v]) => ({ productId, ...v }))
    .sort((a, b) => b.missing - a.missing || a.name.localeCompare(b.name, 'tr'));
  const demandTop = demand.slice(0, 6);

  // Sayaç > listede görünen ⇒ liste kırpılmış. Sessizce "hepsi bu kadar" izlenimi VERİLMEZ.
  const listTruncated = unmappedOrders !== null && unmappedOrders > listedNeedsMapping;
  /** Eşleme işi var mı? Sayaç YOKSA listedeki işaretli satırlar da tek başına yeter. */
  const showMappingWork = (unmappedOrders ?? 0) > 0 || listedNeedsMapping > 0;

  return (
    <div>
      <PageHeader
        icon={Inbox}
        title="Bekleyen Teslimatlar"
        description="Stok bekleyen, kısmen teslim edilmiş, mağaza ürünü panelde eşlenmediği için teslim edilemeyen ve güvenlik incelemesinde tutulan siparişler. Kısmi—otomatik politikalı siparişler stok girince kendiliğinden tamamlanır; eşleme bekleyen kalemler için önce ürün eşleştirmesi, incelemedeki siparişler için İnceleme Kuyruğu'nda onay gerekir."
      >
        {showMappingWork && (
          <Button asChild size="sm">
            <Link href="/mappings">
              <Link2 className="size-4" /> Ürün Eşleştirme
            </Link>
          </Button>
        )}
        {/* Doğrudan stok giriş ekranı — eskiden ürün LİSTESİNE (/stock) gidiyordu, yani
            "Stok Gir" düğmesi hiçbir şey girmiyordu; operatör oradan ürünü bulup detayına
            inmek zorundaydı. Ürün seçimi artık hedef ekranın kendi içinde. */}
        <Button asChild variant="outline" size="sm">
          <Link href="/stock/import">
            <PackagePlus className="size-4" /> Stok Gir
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
              // Beşli kırılım xl'e ertelendi: lg (1024px) kabuğunda içerik yalnız ~720px;
              // StatTile'ın sabit iç payı 80px olduğu için 5 sütunda etikete ~54px kalıyordu.
              // Dörtlü dal lg'de ölçülerek temiz çıktı — gereksiz daraltmak yer israfı olur.
              showMappingWork ? 'lg:grid-cols-3 xl:grid-cols-5' : 'lg:grid-cols-4',
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

          {/*
            İNCELEME UYARISI: held sipariş 'pending' olarak kaydedilir → kuyrukta sıradan bir
            "Bekliyor" satırı gibi görünürdü. Operatör stok girip beklerdi ama autoComplete held
            siparişi ATLAR → hiçbir şey olmaz. Aksiyon /review'dadır; band bunu açıkça söyler.
          */}
          {listedHeld > 0 && (
            <Alert variant="warning" className="mb-4">
              <ClipboardCheck />
              <div className="min-w-0 flex-1">
                <AlertTitle>
                  {listedHeld} sipariş güvenlik incelemesinde bekliyor
                </AlertTitle>
                <AlertDescription>
                  Bu siparişler dinamik satış kotası eşiğini aştığı için manuel onay bekliyor —
                  stok girmek onları teslim ETMEZ. İnceleme Kuyruğu'ndan onaylayın ya da reddedin.
                </AlertDescription>
              </div>
              <Button asChild variant="outline" size="sm" className="shrink-0 self-center">
                <Link href="/review">
                  <ClipboardCheck className="size-3.5" /> İnceleme Kuyruğu
                </Link>
              </Button>
            </Alert>
          )}

          {/*
            ÜRÜN BAZINDA STOK TALEBİ: "neyi stoklayayım" sorusunun tek bakışta cevabı. Her çip
            Stok Girişi ekranını o ürün ön-seçili açar (eskiden operatör siparişleri tek tek
            açıyordu). Kaynak yalnız LİSTELENEN siparişlerdir; bu açıkça yazılır.
          */}
          {demandTop.length > 0 && (
            <Card className="mb-4 p-4">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-medium text-foreground">Stok bekleyen talep</h2>
                <p className="text-[11px] text-muted-foreground">
                  Listelenen {rows.length} siparişten türetildi — genel toplam değildir
                  {demand.length > demandTop.length && ` · ${demand.length} üründen ilk ${demandTop.length}'i`}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {demandTop.map((d) => (
                  <Link
                    key={d.productId}
                    href={`/stock/import?product=${d.productId}`}
                    className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                    title={`${d.name} — ${d.orders} siparişte toplam ${d.missing} lisans eksik. Tıklayınca Stok Girişi bu ürünle açılır.`}
                  >
                    <span className="max-w-[16rem] truncate font-medium text-foreground">{d.name}</span>
                    <span className="shrink-0 tabular-nums text-destructive">{d.missing} eksik</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      · {d.orders} sipariş
                    </span>
                  </Link>
                ))}
              </div>
            </Card>
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
                    {/* ÇOK SİTELİ KURULUMDA ZORUNLU BAĞLAM (operatör şikâyeti): hangi mağazanın
                        siparişi olduğu görünmezse yanlış mağazanın stoğu/eşlemesi incelenir. */}
                    <TableHead>Site</TableHead>
                    <TableHead>Müşteri</TableHead>
                    {/* "Neyi stoklayacağım" bu ekranın ASIL sorusu — ürün kırılımı satırda durur. */}
                    <TableHead>Ürün / eksik adet</TableHead>
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
                    const held = isHeld(o);
                    const summary = readProductSummary(o);
                    return (
                      <TableRow
                        key={o.id}
                        className={cn(
                          // Eşleme arızası en yüksek öncelik; incelemedeki sipariş uyarı tonu
                          // (aksiyon var ama BAŞKA ekranda — satır sıradan "Bekliyor" görünmemeli).
                          held &&
                            !mappingNeeded &&
                            'bg-[color-mix(in_oklch,var(--warning)_7%,transparent)] hover:bg-[color-mix(in_oklch,var(--warning)_12%,transparent)]',
                          mappingNeeded &&
                            'bg-[color-mix(in_oklch,var(--destructive)_7%,transparent)] hover:bg-[color-mix(in_oklch,var(--destructive)_12%,transparent)]',
                        )}
                      >
                        <TableCell className="font-medium text-foreground">{o.remoteOrderId}</TableCell>
                        {/* Site (mağaza): domain + (birden çok kanal tipi varsa anlamlı olan) kanal etiketi.
                            Alan gelmemişse (api/admin sürüm sapması) uydurma değer basma → '—'. */}
                        <TableCell className="whitespace-nowrap">
                          {o.siteDomain ? (
                            <span className="flex flex-col">
                              <span className="text-foreground/90">{o.siteDomain}</span>
                              {o.siteType && (
                                <span className="text-[11px] text-muted-foreground">
                                  {siteTypeLabel(o.siteType)}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-foreground/80">{o.customerEmail}</TableCell>
                        {/* Ürün kırılımı: hangi üründen kaç lisans eksik. Ad, ürün detayına
                            (stok girişi + envanter) bağlanır. Alan yoksa uydurma değer YOK. */}
                        <TableCell className="max-w-[18rem]">
                          {summary.length > 0 ? (
                            <span className="flex flex-col gap-0.5">
                              {summary.slice(0, 3).map((p) => (
                                <span key={p.productId} className="flex items-baseline gap-1.5">
                                  <Link
                                    href={`/products/${p.productId}`}
                                    className="truncate text-foreground/90 underline-offset-2 hover:underline"
                                    title={p.name}
                                  >
                                    {p.name}
                                  </Link>
                                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                                    {p.missing > 0 ? `${p.missing} eksik` : 'tamam'}
                                  </span>
                                </span>
                              ))}
                              {summary.length > 3 && (
                                <span className="text-[11px] text-muted-foreground">
                                  +{summary.length - 3} ürün daha
                                </span>
                              )}
                            </span>
                          ) : mappingNeeded ? (
                            <span className="text-[11px] text-muted-foreground">
                              Eşleme yapılmadan ürün belirlenemiyor
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="flex flex-wrap items-center gap-1.5">
                            {/* §8: held bayrağı ham durumu EZER — 'pending' rozeti "stok bekliyor"
                                yanılgısı üretiyordu (canlı akıştaki orderBadge ile aynı disiplin).
                                StatusBadge 'unmapped' için zaten "Eşlenmemiş" + uyarı rengi üretir. */}
                            <StatusBadge status={held ? 'held_for_review' : o.status} />
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
                          {held && (
                            <span
                              className="mt-0.5 line-clamp-2 block max-w-[16rem] text-[11px] text-warning"
                              title={o.heldReason ?? undefined}
                            >
                              {/* Sebep API'den gelmiyorsa (sürüm sapması) genel ama DOĞRU cümle. */}
                              {o.heldReason?.trim()
                                ? o.heldReason
                                : 'Manuel onay bekliyor — stok girmek teslim etmez'}
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
                            {/* İncelemedeki siparişin tek gerçek aksiyonu /review'da (Onayla/Reddet). */}
                            {held && !mappingNeeded && (
                              <Button asChild variant="outline" size="sm">
                                <Link href="/review">
                                  <ClipboardCheck className="size-3.5" /> İncele
                                </Link>
                              </Button>
                            )}
                            <Button asChild variant="ghost" size="sm">
                              <Link href={`/orders/${o.id}`}>
                                {mappingNeeded || held ? 'Siparişi aç' : 'İşle'}{' '}
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
