import Link from 'next/link';
import {
  AlertOctagon,
  Boxes,
  CalendarClock,
  ClipboardList,
  HelpCircle,
  Info,
  PackageSearch,
  ShoppingCart,
  TriangleAlert,
} from 'lucide-react';
import type { ReorderReport, ReorderRow, ReorderStatus } from '../app/reports/queries';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { StatStrip } from './ui/stat-tile';
import { EmptyState } from './ui/page-header';
import { HelpNote, LegendList } from './ui/help-note';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

/**
 * Yeniden-sipariş önerisi — SUNUM (hesabın tamamı sunucuda, apps/api/.../reorder.service.ts).
 *
 * Sunucu bileşeni: tablo + rozet, etkileşim yok → istemci paketine yük binmez.
 * Yeni renk hue'su EKLENMEZ; rozet tonları mevcut durum diline oturur:
 *   danger = ölü/kritik (stok bitti) · warning = eylem bekliyor · outline = bilgi eksik ·
 *   neutral = kapanmış/sorun yok.
 */

const STATUS_META: Record<
  ReorderStatus,
  { label: string; variant: 'danger' | 'warning' | 'outline' | 'neutral'; hint: string }
> = {
  out: {
    label: 'Stok bitti',
    variant: 'danger',
    hint: 'Kullanılabilir stok kalmadı ama satış sürüyor — sipariş HEMEN açılmalı.',
  },
  order_now: {
    label: 'Şimdi sipariş et',
    variant: 'warning',
    hint: 'Eldeki stok, yeniden sipariş noktasının altına indi: mal gelene kadar tükenir.',
  },
  watch: {
    label: 'Takipte',
    variant: 'outline',
    hint: 'Hedef stok günü penceresine girdi; acil değil ama yakında gerekecek.',
  },
  ok: {
    label: 'Yeterli',
    variant: 'neutral',
    hint: 'Tedarik süresi + emniyet payı boyunca stok yetiyor.',
  },
  unknown_lead: {
    label: 'Tedarik süresi bilinmiyor',
    variant: 'outline',
    hint: 'Bu ürünün tedarikçisi için kapanmış bir satın alma emri yok — öneri üretilemez.',
  },
};

function fmtNum(n: number): string {
  return n.toLocaleString('tr-TR');
}

function fmtDays(d: number | null): string {
  if (d == null) return '—';
  return `${d.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} gün`;
}

/** YYYY-MM-DD → tr-TR tarih. */
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('tr-TR', { dateStyle: 'medium' });
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Kalan gün → ton (raporun kendi eşikleriyle tutarlı; sabit sayı YOK). */
function daysToneClass(row: ReorderRow): string {
  if (row.status === 'out') return 'text-destructive font-medium';
  if (row.status === 'order_now') return 'text-warning font-medium';
  return 'text-foreground';
}

/** Önerilen adet hücresi — MAK'ta birim ↔ anahtar farkı AÇIKÇA yazılır. */
function SuggestionCell({ row }: { row: ReorderRow }) {
  if (row.suggestedKeys == null) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (row.suggestedKeys === 0) {
    return <span className="text-muted-foreground">gerek yok</span>;
  }
  return (
    <div>
      <div className="font-semibold tabular-nums text-foreground">
        {fmtNum(row.suggestedKeys)} adet
      </div>
      {row.unitsPerKey > 1 && (
        <div className="text-xs text-muted-foreground">
          = {fmtNum(row.suggestedUnits ?? 0)} kullanım hakkı ({fmtNum(row.unitsPerKey)}/anahtar)
        </div>
      )}
      {row.openOrderKeys > 0 && (
        <div className="text-xs text-muted-foreground">
          {fmtNum(row.openOrderKeys)} adet zaten yolda (düşüldü)
        </div>
      )}
    </div>
  );
}

function ReorderTable({ rows }: { rows: ReorderRow[] }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Ürün</TableHead>
            <TableHead>Durum</TableHead>
            <TableHead className="text-right">Eldeki stok</TableHead>
            <TableHead className="text-right">Günlük hız</TableHead>
            <TableHead className="text-right">Kalan gün</TableHead>
            <TableHead className="text-right">Tahmini tükenme</TableHead>
            <TableHead>Tedarikçi</TableHead>
            <TableHead className="text-right">Tedarik süresi</TableHead>
            <TableHead className="text-right">Önerilen sipariş</TableHead>
            <TableHead className="text-right">İşlem</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.productId}>
              <TableCell className="max-w-64">
                <Link
                  href={`/products/${r.productId}`}
                  className="truncate font-medium text-foreground underline-offset-4 hover:underline"
                >
                  {r.name}
                </Link>
                <div className="truncate text-xs text-muted-foreground">{r.sku}</div>
              </TableCell>
              <TableCell>
                <Badge variant={STATUS_META[r.status].variant} title={STATUS_META[r.status].hint}>
                  {STATUS_META[r.status].label}
                </Badge>
                {r.belowFixedThreshold && r.lowStockThreshold != null && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    sabit eşiğin ({fmtNum(r.lowStockThreshold)}) altında
                  </div>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{fmtNum(r.available)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {r.dailyRate.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}
              </TableCell>
              <TableCell className={`text-right tabular-nums ${daysToneClass(r)}`}>
                {fmtDays(r.daysRemaining)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{fmtDate(r.stockoutOn)}</TableCell>
              <TableCell className="max-w-40">
                {r.supplierId && r.supplierName ? (
                  <Link
                    href={`/suppliers/${r.supplierId}`}
                    className="truncate underline-offset-4 hover:underline"
                  >
                    {r.supplierName}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">bilinmiyor</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {r.leadDays == null ? (
                  <span className="text-muted-foreground">bilinmiyor</span>
                ) : (
                  fmtDays(r.leadDays)
                )}
              </TableCell>
              <TableCell className="text-right">
                <SuggestionCell row={r} />
              </TableCell>
              <TableCell className="text-right">
                <Link
                  href="/purchase-orders"
                  className="inline-flex items-center gap-1 whitespace-nowrap text-sm font-medium text-foreground underline-offset-4 hover:underline"
                >
                  <ShoppingCart className="size-3.5" /> Emir aç
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function ReportsReorderView({ data }: { data: ReorderReport }) {
  const { params, counts } = data;
  // Satırlar sunucuda ZATEN "tükenmeye en yakın önce" sıralı; filtreler o sırayı korur.
  const act = data.rows.filter((r) => r.status === 'out' || r.status === 'order_now');
  const unknown = data.rows.filter((r) => r.status === 'unknown_lead');
  const rest = data.rows.filter((r) => r.status === 'watch' || r.status === 'ok');

  return (
    <div className="space-y-6">
      <StatStrip
        items={[
          {
            icon: AlertOctagon,
            label: 'Stok bitti',
            value: fmtNum(counts.out),
            tone: counts.out > 0 ? 'danger' : 'default',
          },
          {
            icon: ShoppingCart,
            label: 'Şimdi sipariş et',
            value: fmtNum(counts.order_now),
            tone: counts.order_now > 0 ? 'warning' : 'default',
          },
          { icon: CalendarClock, label: 'Takipte', value: fmtNum(counts.watch) },
          { icon: HelpCircle, label: 'Tedarik süresi bilinmiyor', value: fmtNum(counts.unknown_lead) },
          { icon: Boxes, label: 'Yeterli', value: fmtNum(counts.ok) },
        ]}
      />

      {/* FORMÜL — ekranda da yazılır (sihirli sayı yok). Değerler API'nin `params` alanından. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PackageSearch className="size-4 text-muted-foreground" /> Bu liste nasıl hesaplanıyor?
          </CardTitle>
          <CardDescription>
            Sabit bir düşük-stok eşiği tedarikçinin teslim süresini bilmez; alarm çaldığında
            sipariş vermek geç olabilir. Bu rapor eşiği satış hızından ve tedarik süresinden
            TÜRETİR.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/40 p-4 font-mono text-xs leading-6 text-foreground">
            <div>
              günlük hız = son {params.windowDays} günde tüketilen birim / {params.windowDays}
            </div>
            <div>tahmini tükenme (gün) = eldeki kullanılabilir birim / günlük hız</div>
            <div>
              yeniden sipariş noktası = günlük hız × (tedarik süresi + {params.safetyDays} gün
              emniyet payı)
            </div>
            <div>
              önerilen birim = günlük hız × (tedarik süresi + {params.safetyDays} +{' '}
              {params.coverDays}) − eldeki birim − açık emirlerde bekleyen birim
            </div>
            <div>önerilen adet = önerilen birim / anahtar başına kullanım (yukarı yuvarlanır)</div>
          </div>
          <LegendList
            items={(['out', 'order_now', 'watch', 'unknown_lead', 'ok'] as ReorderStatus[]).map(
              (s) => ({
                term: <Badge variant={STATUS_META[s].variant}>{STATUS_META[s].label}</Badge>,
                text: STATUS_META[s].hint,
              }),
            )}
          />
          <HelpNote title="Sabitler ne anlama geliyor?">
            <ul className="list-disc space-y-1 pl-4">
              <li>
                <strong>Emniyet payı ({params.safetyDays} gün):</strong> tedarik süresi bir
                ORTALAMADIR. Sapma, hafta sonu, ödeme/gümrük gecikmesi için tampon. Sıfır alınsaydı
                alımların yaklaşık yarısı geç kalırdı.
              </li>
              <li>
                <strong>Hedef stok günü ({params.coverDays} gün):</strong> siparişi kaç günlük
                talebi karşılayacak büyüklükte verelim — her hafta yeniden emir açmamak için.
                Satış hızı penceresiyle aynı ({params.windowDays} gün).
              </li>
              <li>
                <strong>Tedarik süresi:</strong> o tedarikçinin KAPANMIŞ satın alma emirlerinde
                «teslim alındı − sipariş verildi» ortalaması (tedarikçi karnesindeki değerin
                aynısı). Stok Girişi&apos;nden açılan otomatik emirlerde sipariş tarihi
                olmadığından bu ortalamaya girmezler.
              </li>
              <li>
                <strong>Birim ↔ adet:</strong> stok ve hız KULLANIM HAKKI (birim) cinsindendir;
                satın alma emri ADET (anahtar) cinsinden. MAK / çok kullanımlı üründe 1 anahtar
                birden çok kullanım taşır, çevrim satır içinde gösterilir.
              </li>
            </ul>
          </HelpNote>
        </CardContent>
      </Card>

      {/* Asıl iş listesi */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShoppingCart className="size-4 text-muted-foreground" /> Şimdi sipariş edilmesi
            gerekenler
          </CardTitle>
          <CardDescription>
            Eldeki stok, mal gelene kadarki talebi karşılamıyor. Satır sonundaki bağlantı Satın
            Alma Emirleri ekranını açar; ürün ve önerilen adet oradaki «Yeni Emir» formuna elle
            girilir (form ön-doldurulmaz).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {act.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="Acil sipariş gerektiren ürün yok"
              description="Tedarik süresi bilinen ürünlerin hepsinde stok, mal gelene kadar yetiyor."
            />
          ) : (
            <ReorderTable rows={act} />
          )}
        </CardContent>
      </Card>

      {/* Tedarik süresi bilinmeyenler — DÜRÜST boşluk, uydurma varsayılan YOK */}
      {unknown.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HelpCircle className="size-4 text-muted-foreground" /> Tedarik süresi bilinmiyor
            </CardTitle>
            <CardDescription>
              Bu ürünler için öneri ÜRETİLMEDİ: tedarikçinin kapanmış (teslim alınmış) bir satın
              alma emri olmadığından ortalama teslim süresi hesaplanamıyor. Varsayılan bir süre
              uydurmak yanlış bir kesinlik satardı — ilk emir kapandıktan sonra kendiliğinden
              hesaplanır. Yine de tükenme tahminini görebilirsiniz.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReorderTable rows={unknown} />
          </CardContent>
        </Card>
      )}

      {/* Takipte + yeterli — acil değil ama gizlenmez (sessiz eksik liste yasak) */}
      {rest.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarClock className="size-4 text-muted-foreground" /> Takipte ve yeterli olanlar
            </CardTitle>
            <CardDescription>
              Acil değil. «Takipte» hedef stok günü penceresine girmiş, «Yeterli» tedarik süresi
              boyunca sorunsuz. Sıra yine tükenmeye en yakın olandan başlar.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReorderTable rows={rest} />
          </CardContent>
        </Card>
      )}

      {data.truncated && (
        <Alert variant="warning">
          <TriangleAlert />
          <div>
            <AlertTitle>Liste kırpıldı</AlertTitle>
            <AlertDescription>
              Yalnız en acil {fmtNum(data.rows.length)} ürün gösteriliyor (tükenmeye en yakın
              olanlar önce). Daha fazlası varsa bir sonraki koşuda görünür.
            </AlertDescription>
          </div>
        </Alert>
      )}

      <Alert variant="muted">
        <Info />
        <div>
          <AlertTitle>Hesaba katılmayanlar</AlertTitle>
          <AlertDescription>
            Son {params.windowDays} günde satışı olmayan{' '}
            <strong>{fmtNum(data.excluded.noSalesProducts)}</strong> ürün listede yok: hız 0
            olduğu için tükenme tarihi türetilemez. Stoksuz / ön sipariş ürünü:{' '}
            <strong>{fmtNum(data.excluded.stocklessProducts)}</strong> (stok tutmaz). İade ve
            değişimde geri alınan atamalar satış sayılmaz, yoksa hız şişip gereğinden çok sipariş
            önerilirdi.
          </AlertDescription>
        </div>
      </Alert>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ClipboardList className="size-3.5" />
        Oluşturulma: {fmtDateTime(data.generatedAt)} · Salt-okunur öneri; hiçbir emir otomatik
        açılmaz.
      </p>
    </div>
  );
}
