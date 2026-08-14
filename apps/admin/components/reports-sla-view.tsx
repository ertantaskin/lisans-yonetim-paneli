'use client';

import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Clock,
  Gauge,
  Hourglass,
  Store,
  Boxes,
  TriangleAlert,
  Timer,
  Info,
} from 'lucide-react';
import type { SlaBreakdownRow, SlaReport } from '../app/reports/queries';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { StatTile } from './ui/stat-tile';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { EmptyState } from './ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

/**
 * Teslimat süresi (SLA) raporu — sunum. Tüm hesap SUNUCUDA yapıldı; burada yalnız
 * biçimlendirme + grafik var (ham enum/İngilizce kullanıcıya çıkmaz).
 *
 * Grafikler recharts (projede zaten var) ve renkler --chart-1..6 token'ları — YENİ HUE YOK.
 */

const COLOR_P50 = 'var(--chart-1)';
const COLOR_P95 = 'var(--chart-2)';
const COLOR_INSTANT = 'var(--chart-3)';
const COLOR_WAITED = 'var(--chart-4)';
const COLOR_OPEN = 'var(--chart-5)';

/** Sayı → tr-TR (binlik ayraç). */
function fmtNum(n: number): string {
  return n.toLocaleString('tr-TR');
}

/**
 * Saniye → okunur süre. 0 (ve altı) "anında" demektir: sipariş ile teslimat AYNI
 * transaction'da yazıldığı için fark tam olarak 0'dır (eşik değil, yapısal).
 */
function fmtDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  if (seconds <= 0) return 'anında';
  const s = Math.round(seconds);
  if (s < 60) return `${s} sn`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk ${s % 60} sn`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} sa ${m % 60} dk`;
  const d = Math.floor(h / 24);
  return `${d} g ${h % 24} sa`;
}

/** Saniye → dakika (grafik ekseni; 1 ondalık). */
function toMinutes(seconds: number | null): number | null {
  return seconds == null ? null : Math.round((seconds / 60) * 10) / 10;
}

/** ISO → tr-TR tarih-saat. */
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
}

/** YYYY-MM-DD → "12 Ağu" (grafik ekseni kısa). */
function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? day
    : d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' });
}

/**
 * Yüzde metni ("%94,7"). Payda 0 ise `null` — ÇAĞIRAN cümleyi kurmaz.
 *
 * Eskiden '—' dönüyordu ve çağıran onu cümlenin içine gömüyordu: ölçülen sipariş 0 olan
 * (ama hâlâ açık siparişi olan) bir pencerede kart ipucu "ölçülenin —'i · stok bekletmedi"
 * diye okunuyordu (denetim bulgusu U8). `null` dönmek "oran YOK" durumunu tip düzeyinde
 * zorunlu kılar. Yüzde işareti Türkçe yazımdaki gibi BAŞTA (jsdoc da buna göre düzeltildi;
 * eski açıklama "142 / 150 · %94,7" diyordu ama fonksiyon hiçbir zaman payı basmıyordu).
 */
function ratio(part: number, total: number): string | null {
  if (total <= 0) return null;
  const pct = Math.round((part / total) * 1000) / 10;
  return `%${pct.toLocaleString('tr-TR')}`;
}

interface DailyDatum {
  day: string;
  label: string;
  p50: number | null;
  p95: number | null;
  instant: number;
  waited: number;
  stillOpen: number;
}

/** Grafik tooltip'i — token temelli, iki tema uyumlu. */
function DurationTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: DailyDatum }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="font-medium text-popover-foreground">{p.label}</div>
      <div className="mt-1 tabular-nums text-foreground">
        Medyan: <strong>{p.p50 == null ? '—' : `${p.p50.toLocaleString('tr-TR')} dk`}</strong>
      </div>
      <div className="tabular-nums text-foreground">
        p95: <strong>{p.p95 == null ? '—' : `${p.p95.toLocaleString('tr-TR')} dk`}</strong>
      </div>
      <div className="mt-1 text-muted-foreground">{fmtNum(p.waited)} sipariş bekledi</div>
    </div>
  );
}

function CountTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: DailyDatum }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="font-medium text-popover-foreground">{p.label}</div>
      <div className="mt-1 tabular-nums text-foreground">Anında: {fmtNum(p.instant)}</div>
      <div className="tabular-nums text-foreground">Bekledi: {fmtNum(p.waited)}</div>
      <div className="tabular-nums text-foreground">Hâlâ açık: {fmtNum(p.stillOpen)}</div>
    </div>
  );
}

/** Mağaza/ürün kırılım tablosu — aynı kolon dili (tek tanım). */
function BreakdownTable({
  rows,
  unitLabel,
  showSku,
}: {
  rows: SlaBreakdownRow[];
  /** "sipariş" ya da "satır" — kırılımın ölçüm birimi. */
  unitLabel: string;
  showSku: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{showSku ? 'Ürün' : 'Mağaza'}</TableHead>
            <TableHead className="text-right">Ölçülen</TableHead>
            <TableHead className="text-right">Anında</TableHead>
            <TableHead className="text-right">Bekledi</TableHead>
            <TableHead className="text-right">Medyan</TableHead>
            <TableHead className="text-right">p95</TableHead>
            <TableHead className="text-right">En kötü</TableHead>
            <TableHead className="text-right">Hâlâ açık</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="max-w-64">
                <div className="truncate font-medium text-foreground">{r.label}</div>
                {showSku && r.sku && (
                  <div className="truncate text-xs text-muted-foreground">{r.sku}</div>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{fmtNum(r.measured)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {fmtNum(r.instant)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{fmtNum(r.waited)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {fmtDuration(r.waitedStats.p50Seconds)}
              </TableCell>
              <TableCell className="text-right tabular-nums font-medium">
                {fmtDuration(r.waitedStats.p95Seconds)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {fmtDuration(r.waitedStats.maxSeconds)}
              </TableCell>
              <TableCell
                className={
                  r.stillOpen > 0
                    ? 'text-right tabular-nums font-medium text-warning'
                    : 'text-right tabular-nums text-muted-foreground'
                }
              >
                {fmtNum(r.stillOpen)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="mt-2 text-xs text-muted-foreground">
        Süreler yalnız BEKLEYEN {unitLabel}lardan hesaplanır; anında teslim edilenler ayrı
        sayılır (ikisini tek ortalamada karıştırmak sinyali yok eder).
      </p>
    </div>
  );
}

export function ReportsSlaView({ data }: { data: SlaReport }) {
  const { totals } = data;

  const daily = React.useMemo<DailyDatum[]>(
    () =>
      data.daily.map((d) => ({
        day: d.day,
        label: shortDay(d.day),
        p50: toMinutes(d.waitedStats.p50Seconds),
        p95: toMinutes(d.waitedStats.p95Seconds),
        instant: d.instant,
        waited: d.waited,
        stillOpen: d.stillOpen,
      })),
    [data.daily],
  );

  const hasAny = totals.measured > 0 || totals.stillOpen > 0;
  if (!hasAny) {
    return (
      <EmptyState
        icon={Timer}
        title="Bu pencerede ölçülecek sipariş yok"
        description={`Son ${data.windowDays} günde teslimat süresi hesaplanabilecek sipariş bulunmuyor. Pencereyi genişletmeyi deneyin.`}
      />
    );
  }

  const anyWaited = totals.waited > 0;
  /** Anında teslim oranı — ölçülen sipariş yoksa `null` (cümle hiç kurulmaz, bkz. `ratio`). */
  const instantRatio = ratio(totals.instant, totals.measured);

  return (
    <div className="space-y-6">
      {/* Özet kartları */}
      <div className="grid gap-3 [&>*]:min-w-0 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Ölçülen sipariş"
          value={fmtNum(totals.measured)}
          icon={Gauge}
          tone="accent"
          hint={`son ${data.windowDays} gün`}
        />
        <StatTile
          label="Anında teslim"
          value={fmtNum(totals.instant)}
          icon={Clock}
          tone="success"
          /* Ölçülen sipariş yoksa oran cümlesi KURULMAZ ("ölçülenin —'i" diye okunuyordu).
             Pencerede hâlâ açık sipariş olabilir → "veri yok" ile "0" karıştırılmasın diye
             sebebi söylenir. */
          hint={
            instantRatio
              ? `ölçülenin ${instantRatio} kadarı · stok bekletmedi`
              : 'bu pencerede ölçülen sipariş yok — oran hesaplanamıyor'
          }
        />
        <StatTile
          label="Stok bekledi"
          value={fmtNum(totals.waited)}
          icon={Hourglass}
          tone={totals.waited > 0 ? 'warning' : 'neutral'}
          hint={
            anyWaited
              ? `medyan ${fmtDuration(totals.waitedStats.p50Seconds)} · p95 ${fmtDuration(totals.waitedStats.p95Seconds)}`
              : 'bekleyen sipariş yok'
          }
        />
        <StatTile
          label="Hâlâ açık"
          value={fmtNum(totals.stillOpen)}
          icon={TriangleAlert}
          tone={totals.stillOpen > 0 ? 'warning' : 'neutral'}
          hint="bu penceredeki tamamlanmamış sipariş"
        />
      </div>

      {/* Kohort dürüstlüğü: tamamlanmamış siparişler ortalamaya GİREMEZ. */}
      {totals.stillOpen > 0 && (
        <Alert variant="warning">
          <TriangleAlert />
          <div>
            <AlertTitle>{fmtNum(totals.stillOpen)} sipariş hâlâ tamamlanmadı</AlertTitle>
            <AlertDescription>
              Bu siparişlerin teslim süresi HENÜZ ölçülemez, bu yüzden aşağıdaki ortalama /
              medyan / p95 değerlerinin İÇİNDE DEĞİLLER. Yani gerçek süre bu rapordaki
              rakamlardan daha kötü olabilir; kuyruğu «Bekleyen Teslimatlar» ekranından takip edin.
            </AlertDescription>
          </div>
        </Alert>
      )}

      {/* Süre serisi (yalnız bekleyenler) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Hourglass className="size-4 text-muted-foreground" /> Bekleme süresi (dakika)
          </CardTitle>
          <CardDescription>
            Stok bekleyen siparişlerin günlük medyanı (p50) ve p95'i. Tek bir yavaş sipariş
            ortalamayı uçurduğu için asıl ölçüt bu iki değerdir. Anında teslim edilenler bu
            grafiğe girmez.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {anyWaited ? (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={daily} margin={{ top: 8, right: 8, left: -8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    tickLine={false}
                    axisLine={{ stroke: 'var(--border)' }}
                    minTickGap={16}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => fmtNum(Number(v))}
                  />
                  <Tooltip content={<DurationTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="p50"
                    name="Medyan (dk)"
                    stroke={COLOR_P50}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="p95"
                    name="p95 (dk)"
                    stroke={COLOR_P95}
                    strokeWidth={2}
                    strokeDasharray="4 3"
                    dot={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyState
              icon={Clock}
              title="Bu pencerede hiçbir sipariş stok beklemedi"
              description="Tüm siparişler aynı anda (stok elde olduğu için) teslim edildi."
            />
          )}
        </CardContent>
      </Card>

      {/* Günlük adet dağılımı */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Timer className="size-4 text-muted-foreground" /> Günlük sipariş dağılımı
          </CardTitle>
          <CardDescription>
            Siparişin panele düştüğü güne göre: anında teslim / stok bekleyip teslim edilen /
            hâlâ tamamlanmamış.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={daily} margin={{ top: 8, right: 8, left: -8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                  tickLine={false}
                  axisLine={{ stroke: 'var(--border)' }}
                  minTickGap={16}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                  tickFormatter={(v: number) => fmtNum(Number(v))}
                />
                <Tooltip cursor={{ fill: 'var(--muted)', opacity: 0.4 }} content={<CountTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="instant" name="Anında" stackId="a" fill={COLOR_INSTANT} />
                <Bar dataKey="waited" name="Bekledi" stackId="a" fill={COLOR_WAITED} />
                <Bar
                  dataKey="stillOpen"
                  name="Hâlâ açık"
                  stackId="a"
                  fill={COLOR_OPEN}
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Mağaza kırılımı */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Store className="size-4 text-muted-foreground" /> Mağaza kırılımı
          </CardTitle>
          <CardDescription>
            Hangi mağazada bekleme birikiyor? Önce açık kalan siparişi çok olan, sonra p95'i
            yüksek olan gelir.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.bySite.length === 0 ? (
            <EmptyState icon={Store} title="Bu pencerede mağaza verisi yok" />
          ) : (
            <>
              {data.truncated.bySite && (
                <Alert variant="warning" className="mb-3">
                  <TriangleAlert />
                  <AlertDescription>
                    Liste kırpıldı — yalnız ilk {data.bySite.length} mağaza gösteriliyor.
                  </AlertDescription>
                </Alert>
              )}
              <BreakdownTable rows={data.bySite} unitLabel="sipariş" showSku={false} />
            </>
          )}
        </CardContent>
      </Card>

      {/* Ürün kırılımı */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Boxes className="size-4 text-muted-foreground" /> Ürün kırılımı
          </CardTitle>
          <CardDescription>
            SATIR bazında ölçülür (bir sipariş birden çok ürün taşıyabilir). Eşlenmemiş satırlar
            burada görünmez — onlar «Ürün Eşleştirme» ekranının işidir.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.byProduct.length === 0 ? (
            <EmptyState icon={Boxes} title="Bu pencerede ürün verisi yok" />
          ) : (
            <>
              {data.truncated.byProduct && (
                <Alert variant="warning" className="mb-3">
                  <TriangleAlert />
                  <AlertDescription>
                    Liste kırpıldı — yalnız ilk {data.byProduct.length} ürün gösteriliyor.
                  </AlertDescription>
                </Alert>
              )}
              <BreakdownTable rows={data.byProduct} unitLabel="satır" showSku />
            </>
          )}
        </CardContent>
      </Card>

      {/* Hesap dışı bırakılanlar — sessiz eleme yok */}
      <Alert variant="muted">
        <Info />
        <div>
          <AlertTitle>Hesaba katılmayanlar</AlertTitle>
          <AlertDescription>
            İncelemedeki sipariş: <strong>{fmtNum(data.excluded.heldOrders)}</strong> (teslimat
            bilerek insan onayını bekler) · iptal edilen satır:{' '}
            <strong>{fmtNum(data.excluded.canceledLines)}</strong> · bonus satırı:{' '}
            <strong>{fmtNum(data.excluded.bonusLines)}</strong> (mağazadan gelen talep değil).
            Değişimle sonradan verilen taze anahtarlar da süreye eklenmez — ilk teslimat çoktan
            yapılmıştır.
            {/* Ölçülebilir satırı olmayan sipariş: ne "ölçüldü"ye ne "hâlâ açık"a girer —
                sayılmasaydı iki sayacın toplamı sipariş sayısını tutmaz, operatör farkı
                arardı. Alan opsiyonel: eski API ile de çalışır (dağıtım sapması). */}
            {(data.excluded.ordersWithoutMeasurableLines ?? 0) > 0 && (
              <>
                {' '}
                Ayrıca <strong>{fmtNum(data.excluded.ordersWithoutMeasurableLines ?? 0)}</strong>{' '}
                siparişin ölçülebilir satırı yok (tüm satırları elenmiş ya da hiç satırı yok);
                bunlar ne ölçülene ne de hâlâ açık olanlara dahildir.
              </>
            )}
          </AlertDescription>
        </div>
      </Alert>

      <p className="text-xs text-muted-foreground">
        Oluşturulma: {fmtDateTime(data.generatedAt)} · Pencere: {fmtDateTime(data.from)} –{' '}
        {fmtDateTime(data.to)}
      </p>
    </div>
  );
}
