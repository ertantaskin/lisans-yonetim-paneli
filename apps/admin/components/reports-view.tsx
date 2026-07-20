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
  ShoppingCart,
  Clock,
  Boxes,
  RefreshCcw,
  PackageCheck,
  Gauge,
  type LucideIcon,
} from 'lucide-react';
import type { ReportsOverview } from '../app/reports/queries';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { StatTile } from './ui/stat-tile';
import { StatusBadge } from './ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table';
import { EmptyState } from './ui/page-header';

// Grafik renk döngüsü (globals.css --chart-1..6, iki tema uyumlu).
const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
];

/** Sayı → tr-TR biçim (binlik ayraç). */
function fmtNum(n: number): string {
  return n.toLocaleString('tr-TR');
}

/** Recharts tooltip — token temelli, iki tema uyumlu. */
function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; payload: { name: string; sku: string } }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="font-medium text-popover-foreground">{p.payload.name || label}</div>
      <div className="text-muted-foreground">{p.payload.sku}</div>
      <div className="mt-1 tabular-nums text-foreground">
        Kullanılabilir: <span className="font-semibold">{fmtNum(p.value)}</span>
      </div>
    </div>
  );
}

/** Kalan gün → ton (az gün = kritik). */
function daysTone(days: number | null): { text: string; cls: string } {
  if (days === null) return { text: '—', cls: 'text-muted-foreground' };
  const rounded = Math.round(days);
  if (days <= 7) return { text: `${rounded} gün`, cls: 'text-destructive font-medium' };
  if (days <= 21) return { text: `${rounded} gün`, cls: 'text-warning font-medium' };
  return { text: `${rounded} gün`, cls: 'text-foreground' };
}

export function ReportsView({ data }: { data: ReportsOverview }) {
  const { orders, fulfillment, stock, velocity, replacements } = data;

  // Stok grafiği: en yüksek 12 ürün (okunabilirlik). Recharts client'ta çalışır.
  const chartData = React.useMemo(
    () =>
      [...stock.byProduct]
        .sort((a, b) => b.available - a.available)
        .slice(0, 12)
        .map((p) => ({ ...p, label: p.sku || p.name })),
    [stock.byProduct],
  );

  const replRatePct = Math.round(replacements.rate * 1000) / 10; // % (1 ondalık)

  // Sipariş durumu dağılımı (byStatus) — çoktan aza.
  const statusEntries = Object.entries(orders.byStatus).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6">
      {/* Özet kartları */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Toplam Sipariş"
          value={fmtNum(orders.total)}
          icon={ShoppingCart}
          tone="accent"
        />
        <StatTile
          label="Bekleyen Satır"
          value={fmtNum(fulfillment.pending)}
          icon={Clock}
          tone={fulfillment.pending > 0 ? 'warning' : 'success'}
          hint={`${fmtNum(fulfillment.lines)} satırın`}
        />
        <StatTile
          label="Toplam Stok"
          value={fmtNum(stock.totalAvailable)}
          icon={Boxes}
          tone={stock.totalAvailable > 0 ? 'neutral' : 'danger'}
          hint="kullanılabilir birim"
        />
        <StatTile
          label="Değişim Oranı"
          value={`%${replRatePct}`}
          icon={RefreshCcw}
          tone={replRatePct >= 10 ? 'warning' : 'neutral'}
          hint={`${fmtNum(replacements.approved)}/${fmtNum(replacements.total)} onaylı`}
        />
      </div>

      {/* Stok grafiği (recharts bar) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Boxes className="size-4 text-muted-foreground" /> Ürün Başına Stok
          </CardTitle>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <EmptyState icon={Boxes} title="Stok verisi yok" description="Henüz kullanılabilir stok bulunmuyor." />
          ) : (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 8, left: -16, bottom: 8 }}>
                  <XAxis
                    dataKey="label"
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
                    allowDecimals={false}
                  />
                  <Tooltip
                    cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
                    content={<ChartTooltip />}
                  />
                  <Bar dataKey="available" radius={[4, 4, 0, 0]}>
                    {chartData.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Teslimat dağılımı */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PackageCheck className="size-4 text-muted-foreground" /> Teslimat Dağılımı
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FulfillBar label="Teslim edildi" value={fulfillment.fulfilled} total={fulfillment.lines} tone="success" />
            <FulfillBar label="Kısmi" value={fulfillment.partial} total={fulfillment.lines} tone="warning" />
            <FulfillBar label="Bekliyor" value={fulfillment.pending} total={fulfillment.lines} tone="neutral" />
            <p className="pt-1 text-xs text-muted-foreground">
              Toplam {fmtNum(fulfillment.lines)} sipariş satırı.
            </p>
          </CardContent>
        </Card>

        {/* Sipariş durumu */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShoppingCart className="size-4 text-muted-foreground" /> Sipariş Durumu
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statusEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sipariş yok.</p>
            ) : (
              <ul className="space-y-2.5">
                {statusEntries.map(([status, count]) => (
                  <li key={status} className="flex items-center justify-between gap-2">
                    <StatusBadge status={status} />
                    <span className="tabular-nums text-sm font-medium text-foreground">{fmtNum(count)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Satış hızı tablosu */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="size-4 text-muted-foreground" /> Satış Hızı & Tükenme
          </CardTitle>
        </CardHeader>
        <CardContent className={velocity.length === 0 ? '' : 'p-0'}>
          {velocity.length === 0 ? (
            <EmptyState icon={Gauge} title="Hız verisi yok" description="Son 30 günde atama bulunmuyor." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Ürün (SKU)</TableHead>
                    <TableHead className="text-right">7g</TableHead>
                    <TableHead className="text-right">30g</TableHead>
                    <TableHead className="text-right">Günlük</TableHead>
                    <TableHead className="text-right">Tahmini Tükenme</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {velocity.map((v) => {
                    const dt = daysTone(v.daysRemaining);
                    return (
                      <TableRow key={v.productId}>
                        <TableCell className="font-medium text-foreground">{v.sku}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(v.sold7d)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(v.sold30d)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {v.dailyRate.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}
                        </TableCell>
                        <TableCell className={`text-right tabular-nums ${dt.cls}`}>{dt.text}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Yardımcı: CSS-tabanlı yatay teslimat çubuğu (harici bağımlılık yok) ───────
function FulfillBar({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: 'success' | 'warning' | 'neutral';
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  const fill: Record<string, string> = {
    success: 'bg-success',
    warning: 'bg-warning',
    neutral: 'bg-muted-foreground/50',
  };
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {fmtNum(value)} <span className="text-xs">(%{pct})</span>
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${fill[tone]}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
