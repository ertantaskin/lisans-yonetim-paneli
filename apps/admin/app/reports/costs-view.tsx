'use client';

import * as React from 'react';
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Loader2,
  TriangleAlert,
  Coins,
  Warehouse,
  PackageX,
  Building2,
  Boxes,
  CalendarDays,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { StatTile } from '../../components/ui/stat-tile';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { EmptyState } from '../../components/ui/page-header';

// ── Sözleşme (backend ile AYNI): salt-okunur TEDARİK maliyeti, gelir/kâr YOK ──
interface BySupplier {
  supplierId: string;
  supplier: string;
  currency: string;
  spentCents: number;
  poCount: number;
}
interface ByMonth {
  month: string;
  currency: string;
  spentCents: number;
}
interface ByProduct {
  productId: string;
  product: string;
  currency: string;
  spentCents: number;
  qtyReceived: number;
}
interface Valuation {
  currency: string;
  valuedCents: number;
  valuedUnits: number;
  uncoveredUnits: number;
}
interface Wastage {
  currency: string;
  wastedCents: number;
  events: number;
  uncoveredEvents: number;
}
interface CostReport {
  generatedAt: string;
  bySupplier: BySupplier[];
  byMonth: ByMonth[];
  byProduct: ByProduct[];
  valuation: Valuation[];
  wastage: Wastage[];
}

// Grafik renk döngüsü (globals.css --chart-1..6, iki tema uyumlu).
const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
];

/** Kuruş → para birimi metni (ör. 12000 TRY → "120,00 TRY"). Para birimi satır başına. */
function money(cents: number, currency: string): string {
  return `${(cents / 100).toLocaleString('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

/** Sayı → tr-TR biçim (binlik ayraç). */
function fmtNum(n: number): string {
  return n.toLocaleString('tr-TR');
}

/** ISO → tr-TR tarih-saat. */
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Hata gövdesinden okunabilir mesaj (proxy {error} veya Nest {message}). */
function errText(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as { error?: unknown; message?: unknown };
    if (typeof b.error === 'string') return b.error;
    if (typeof b.message === 'string') return b.message;
  }
  return fallback;
}

// Grafik datum'u (para birimi başına gruplanır → tek eksende karıştırılmaz).
interface Datum {
  key: string;
  value: number; // birim (kuruş/100) — çubuk yüksekliği
  cents: number;
  currency: string;
  sub?: string;
}

/** Para birimine göre grupla → [currency, rows][] (para birimi alfabetik). */
function groupByCurrency<T extends { currency: string }>(rows: T[]): Array<[string, T[]]> {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const bucket = map.get(r.currency);
    if (bucket) bucket.push(r);
    else map.set(r.currency, [r]);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Recharts tooltip — token temelli, para birimini biçimlendirir. */
function MoneyTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: Datum }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="font-medium text-popover-foreground">{p.key}</div>
      <div className="mt-1 tabular-nums font-semibold text-foreground">{money(p.cents, p.currency)}</div>
      {p.sub && <div className="text-muted-foreground">{p.sub}</div>}
    </div>
  );
}

/** Tek para birimi için maliyet çubuğu grafiği. */
function CostBars({ rows }: { rows: Datum[] }) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, left: -8, bottom: 8 }}>
          <XAxis
            dataKey="key"
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={{ stroke: 'var(--border)' }}
            interval={0}
            angle={-30}
            textAnchor="end"
            height={56}
          />
          <YAxis
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => fmtNum(Number(v))}
          />
          <Tooltip cursor={{ fill: 'var(--muted)', opacity: 0.4 }} content={<MoneyTooltip />} />
          <Bar dataKey="value" radius={[4, 4, 0, 0]}>
            {rows.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Kart içi, para birimi başına ayrı grafik blokları. Birden fazla para birimi varsa
 * her biri kendi başlığıyla ayrı çizilir (tek eksende karıştırma yok).
 */
function ChartCard({
  title,
  icon: Icon,
  description,
  groups,
  multiCurrency,
}: {
  title: string;
  icon: LucideIcon;
  description: string;
  groups: Array<[string, Datum[]]>;
  multiCurrency: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" /> {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {groups.map(([currency, rows]) => (
          <div key={currency}>
            {multiCurrency && (
              <div className="mb-1 text-xs font-medium text-muted-foreground">{currency}</div>
            )}
            <CostBars rows={rows} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function CostsView() {
  const [data, setData] = React.useState<CostReport | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/reports/costs', { cache: 'no-store' });
        const body = (await res.json().catch(() => null)) as CostReport | { error?: string } | null;
        if (!res.ok || !body || !('generatedAt' in body)) {
          if (alive) setError(errText(body, `Maliyet raporu alınamadı (${res.status}).`));
          return;
        }
        if (alive) setData(body);
      } catch {
        if (alive) setError('Ağ hatası — maliyet raporu alınamadı.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Para birimi kümesi + karışık mı? (tüm bölümlerin birleşimi)
  const currencies = React.useMemo(() => {
    if (!data) return [] as string[];
    const set = new Set<string>();
    for (const r of data.valuation) set.add(r.currency);
    for (const r of data.wastage) set.add(r.currency);
    for (const r of data.byMonth) set.add(r.currency);
    for (const r of data.bySupplier) set.add(r.currency);
    for (const r of data.byProduct) set.add(r.currency);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [data]);
  const multiCurrency = currencies.length > 1;

  // Aylık harcama (para birimi başına, ay artan) → Datum grupları.
  const monthGroups = React.useMemo<Array<[string, Datum[]]>>(() => {
    if (!data) return [];
    return groupByCurrency(data.byMonth).map(([currency, rows]): [string, Datum[]] => [
      currency,
      [...rows]
        .sort((a, b) => a.month.localeCompare(b.month))
        .map((r) => ({ key: r.month, value: r.spentCents / 100, cents: r.spentCents, currency })),
    ]);
  }, [data]);

  // Tedarikçi kırılımı (para birimi başına, harcama azalan, ilk 12).
  const supplierGroups = React.useMemo<Array<[string, Datum[]]>>(() => {
    if (!data) return [];
    return groupByCurrency(data.bySupplier).map(([currency, rows]): [string, Datum[]] => [
      currency,
      [...rows]
        .sort((a, b) => b.spentCents - a.spentCents)
        .slice(0, 12)
        .map((r) => ({
          key: r.supplier,
          value: r.spentCents / 100,
          cents: r.spentCents,
          currency,
          sub: `${fmtNum(r.poCount)} satın alma emri`,
        })),
    ]);
  }, [data]);

  // Ürün kırılımı (para birimi başına, harcama azalan, ilk 12).
  const productGroups = React.useMemo<Array<[string, Datum[]]>>(() => {
    if (!data) return [];
    return groupByCurrency(data.byProduct).map(([currency, rows]): [string, Datum[]] => [
      currency,
      [...rows]
        .sort((a, b) => b.spentCents - a.spentCents)
        .slice(0, 12)
        .map((r) => ({
          key: r.product,
          value: r.spentCents / 100,
          cents: r.spentCents,
          currency,
          sub: `${fmtNum(r.qtyReceived)} birim alındı`,
        })),
    ]);
  }, [data]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Maliyet raporu yükleniyor…
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!data) return null;

  const hasAny =
    data.valuation.length > 0 ||
    data.wastage.length > 0 ||
    data.byMonth.length > 0 ||
    data.bySupplier.length > 0 ||
    data.byProduct.length > 0;

  if (!hasAny) {
    return (
      <EmptyState
        icon={Coins}
        title="Maliyet verisi yok"
        description="Henüz teslim alınmış satın alma emri veya maliyet kaydı bulunmuyor."
      />
    );
  }

  const uncoveredUnits = data.valuation.reduce((s, v) => s + v.uncoveredUnits, 0);
  const uncoveredEvents = data.wastage.reduce((s, w) => s + w.uncoveredEvents, 0);

  return (
    <div className="space-y-6">
      {multiCurrency && (
        <Alert variant="info">
          <Coins />
          <div>
            <AlertTitle>Karışık para birimi</AlertTitle>
            <AlertDescription>
              Kayıtlar birden fazla para birimi içeriyor ({currencies.join(', ')}). Tutarlar para
              birimi bazında AYRI gösterilir; farklı para birimleri toplanmaz.
            </AlertDescription>
          </div>
        </Alert>
      )}

      {/* Değerleme + Fire (StatTile, para birimi başına) */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {data.valuation.map((v) => (
          <StatTile
            key={`val-${v.currency}`}
            label={multiCurrency ? `Stok Değeri (${v.currency})` : 'Stok Değeri (maliyet)'}
            value={money(v.valuedCents, v.currency)}
            icon={Warehouse}
            tone="accent"
            hint={`${fmtNum(v.valuedUnits)} birim maliyetli`}
          />
        ))}
        {data.wastage.map((w) => (
          <StatTile
            key={`waste-${w.currency}`}
            label={multiCurrency ? `Fire / İmha (${w.currency})` : 'Fire / İmha (maliyet)'}
            value={money(w.wastedCents, w.currency)}
            icon={PackageX}
            tone={w.wastedCents > 0 ? 'warning' : 'neutral'}
            hint={`${fmtNum(w.events)} olay`}
          />
        ))}
      </div>

      {/* Maliyeti bağlanamayan uyarısı */}
      {(uncoveredUnits > 0 || uncoveredEvents > 0) && (
        <Alert variant="warning">
          <TriangleAlert />
          <div>
            <AlertTitle>Maliyeti bağlanamayan kayıtlar</AlertTitle>
            <AlertDescription>
              {uncoveredUnits > 0 && <>{fmtNum(uncoveredUnits)} birim</>}
              {uncoveredUnits > 0 && uncoveredEvents > 0 && ' ve '}
              {uncoveredEvents > 0 && <>{fmtNum(uncoveredEvents)} fire olayı</>} bir satın alma
              emrine (PO) bağlanamadı. Bu kayıtların birim maliyeti bilinmediğinden yukarıdaki
              toplamlar OLDUĞUNDAN DÜŞÜK görünebilir.
            </AlertDescription>
          </div>
        </Alert>
      )}

      {/* Aylık harcama zaman serisi */}
      {monthGroups.length > 0 && (
        <ChartCard
          title="Aylık Tedarik Harcaması"
          icon={CalendarDays}
          description="Ay bazında satın alma emri harcaması (yalnız maliyet)."
          groups={monthGroups}
          multiCurrency={multiCurrency}
        />
      )}

      {/* Tedarikçi + Ürün kırılımı */}
      {supplierGroups.length > 0 && (
        <ChartCard
          title="Tedarikçi Kırılımı"
          icon={Building2}
          description="Tedarikçi bazında toplam harcama (en yüksek 12)."
          groups={supplierGroups}
          multiCurrency={multiCurrency}
        />
      )}

      {productGroups.length > 0 && (
        <ChartCard
          title="Ürün Kırılımı"
          icon={Boxes}
          description="Ürün bazında toplam tedarik maliyeti (en yüksek 12)."
          groups={productGroups}
          multiCurrency={multiCurrency}
        />
      )}

      <p className="text-xs text-muted-foreground">
        Oluşturulma: {fmtDateTime(data.generatedAt)} · Gelir/kâr içermez; yalnız tedarik maliyeti.
      </p>
    </div>
  );
}
