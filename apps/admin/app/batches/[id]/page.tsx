import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Boxes,
  Calendar,
  ExternalLink,
  KeyRound,
  Package,
  PackagePlus,
  Truck,
  Users,
} from 'lucide-react';
import { apiGet } from '../../../lib/api';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { SupplyStatusBadge } from '../../../components/ui/badge';
import { StatStrip } from '../../../components/ui/stat-tile';
import { LicenseItemsTable } from '../../../components/inventory/license-items-table';
import { BatchRecallButton } from '../../../components/batch-recall-button';
import type { BatchRow } from '../queries';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fmtDate(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('tr-TR', { dateStyle: 'medium' });
}

/**
 * PARTİ DETAYI (§12) — "bu partide ne var, ne oldu".
 *
 * NEDEN VAR (kullanıcı isteği): parti listesi yalnız sayaç gösteriyordu; partinin İÇİNDEKİ
 * anahtarları görmek için ürün detayına gidip oradaki envanteri elle süzmek gerekiyordu —
 * ürün detayı ise partiye göre daraltılmadığı için "hangi anahtar bu partiden geldi"
 * sorusunun cevabı yoktu. Artık envanter tablosu `batchId` ile bu partiye kilitlenir:
 * teslim edilenler, geçersiz kılınanlar, karantinadakiler HEPSİ burada; toplu seçimle
 * geçersiz kılma/hasarlı işaretleme de buradan yapılır (tablonun kendi toplu aksiyonu).
 *
 * BAŞLIKLAR PARTİ DİLİNDE: "Bu partideki lisanslar", "Partiyi geri çek" — ekranın kapsamı
 * ne ise adı da odur (kullanıcı geri bildirimi).
 */
export default async function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  let batch: BatchRow;
  try {
    batch = await apiGet<BatchRow>(`/v1/admin/batches/${id}`);
  } catch {
    notFound();
  }

  // KOVALAR TOPLANMAZ (MAK): çok kullanımlı bir anahtar kısmen satılmışken hem stokta hem
  // müşterilerde sayılır. Bu yüzden "kayıtlı lisans" API'nin verdiği TOPLAM kalemdir,
  // kovaların toplamı DEĞİL — aksi halde MAK'lı partide sayfa kendi kendisiyle çelişirdi.
  const total = batch.totalCount;
  const recalled = batch.status === 'recalled';

  return (
    <div className="space-y-6">
      {/* ── Başlık ── */}
      <div className="space-y-3">
        <Link
          href="/batches"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden /> Partiler
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
              <Package className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h1 className="font-mono text-2xl font-semibold tracking-tight text-foreground">
                {batch.label}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                <SupplyStatusBadge status={batch.status} />
                <span className="inline-flex items-center gap-1.5">
                  <Truck className="size-3.5" aria-hidden />
                  {batch.supplierName ? (
                    batch.supplierId ? (
                      <Link
                        href={`/suppliers/${batch.supplierId}`}
                        className="text-foreground underline-offset-4 hover:underline"
                      >
                        {batch.supplierName}
                      </Link>
                    ) : (
                      batch.supplierName
                    )
                  ) : (
                    'Tedarikçi yok'
                  )}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Calendar className="size-3.5" aria-hidden />
                  {fmtDate(batch.receivedAt)} alındı
                </span>
                <Link
                  href={`/products/${batch.productId}`}
                  className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
                >
                  {batch.productName}
                  <span className="font-mono text-xs text-muted-foreground">
                    {batch.productSku}
                  </span>
                  <ExternalLink className="size-3" aria-hidden />
                </Link>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/stock/import?product=${batch.productId}&batch=${batch.id}`}>
                <PackagePlus /> Bu partiye stok gir
              </Link>
            </Button>
            {batch.status === 'active' && (
              <BatchRecallButton
                batchId={batch.id}
                label={batch.label}
                unsold={batch.unsoldCount}
                customer={batch.customerCount}
              />
            )}
          </div>
        </div>
      </div>

      {/* ── Sayaçlar ── */}
      <div className="space-y-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Boxes className="size-4 text-muted-foreground" aria-hidden /> Parti özeti
        </h2>
        <StatStrip
          items={[
            {
              icon: Package,
              label: 'Alınan',
              value: batch.qtyReceived,
              hint: 'teslim alınan adet',
            },
            {
              icon: Boxes,
              label: 'Stokta',
              value: batch.unsoldCount,
              tone: batch.unsoldCount === 0 ? 'default' : 'success',
              hint: 'satılabilir, geri çekmede iptal olur',
            },
            {
              icon: Users,
              label: 'Müşterilerde',
              value: batch.customerCount,
              tone: recalled && batch.customerCount > 0 ? 'warning' : 'default',
              hint: 'canlı atama — çalışmaya devam ediyor',
            },
            {
              icon: KeyRound,
              label: 'Düşmüş',
              value: batch.deadCount,
              hint: 'iptal / karantina / iade / değiştirilmiş',
            },
            {
              icon: Package,
              label: 'Kayıtlı lisans',
              value: total,
              hint: total !== batch.qtyReceived ? 'beyan edilenden farklı' : 'beyanla aynı',
              tone: total !== batch.qtyReceived ? 'warning' : 'default',
            },
          ]}
        />
        {batch.notes && (
          <p className="text-xs text-muted-foreground">
            <strong className="font-medium text-foreground">Not:</strong> {batch.notes}
          </p>
        )}
      </div>

      {/* ── Müşterilerdeki anahtarlar (değişim karar listesi) ──
          NEDEN AYRI KART: geri çekme YALNIZ stoğu geçersiz kılar; teslim edilmiş anahtarlara
          dokunmaz çünkü bir kısmı çalışıyor olabilir. Operatörün ihtiyacı "hangileri hâlâ
          müşterilerde" listesini görüp SATIR SATIR karar vermek — bu kart o iş listesidir ve
          bir anahtar değiştirildikçe kendiliğinden kısalır (eski atama artık canlı değildir). */}
      {batch.customerCount > 0 && (
        <Card>
          <CardHeader>
            <CardTitle icon={Users}>Müşterilerdeki lisanslar</CardTitle>
            <CardDescription>
              Bu partiden çıkmış ve <strong>şu anda müşterilerin elinde olan</strong>{' '}
              {batch.customerCount} anahtar. {recalled ? 'Parti geri çekildi ama b' : 'B'}
              unlar çalışmaya devam ediyor ve müşteri görmeye devam ediyor — otomatik
              iptal edilmezler. Sorunlu olanı satırdaki{' '}
              <strong>“Yeni anahtarla değiştir”</strong> ile yenileyin: müşteriye başka bir
              partiden taze anahtar atanır, eski anahtar karantinaya gider ve bu listeden düşer.
              Uygun stok yoksa işlem yapılmaz, müşteri boşta kalmaz.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LicenseItemsTable batchId={batch.id} lockedHolder="customer" />
          </CardContent>
        </Card>
      )}

      {/* ── Partinin lisansları ── */}
      <Card>
        <CardHeader>
          <CardTitle icon={KeyRound}>Bu partideki lisanslar</CardTitle>
          <CardDescription>
            Yalnız <strong>{batch.label}</strong> partisinden gelen kalemler — teslim edilenler,
            geçersiz kılınanlar ve karantinadakiler dahil. Bozuk anahtarları satırları
            işaretleyip topluca stoktan düşebilirsiniz.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LicenseItemsTable batchId={batch.id} />
        </CardContent>
      </Card>
    </div>
  );
}
