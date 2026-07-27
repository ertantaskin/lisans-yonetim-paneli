'use client';
import { PackageSearch } from 'lucide-react';
import type { ProductRow, UnmappedRow } from '../lib/api';
import { Card } from './ui/card';
import { EmptyState } from './ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { MapProductSheet } from './map-product-sheet';

/** ISO tarih → tr-TR gün/ay/yıl (geçersizse em-dash). */
function trDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Ad yoksa (eski sipariş) tutarlı yer tutucu — hem tabloda hem sheet'te aynı metin. */
function displayName(row: UnmappedRow): string {
  return row.remoteName ?? '(ad yok — eski sipariş)';
}

/** Aynı remoteProductId farklı sitelerde olabilir → site+ürün+varyasyon ile benzersiz anahtar. */
function rowKey(row: UnmappedRow): string {
  return `${row.siteId}:${row.remoteProductId}:${row.remoteVariationId ?? ''}`;
}

/**
 * Eşlenmemiş gelen ürünler tablosu (§3). Her satır: site + mağaza ürünü (ad + #id + varyasyon) +
 * sipariş/kalem sayısı + son görülme + tek-tıkla "Eşle". Boşsa: tüm gelen siparişler eşli.
 */
export function UnmappedTable({ rows, products }: { rows: UnmappedRow[]; products: ProductRow[] }) {
  if (rows.length === 0) {
    return (
      <Card className="p-0">
        <EmptyState
          icon={PackageSearch}
          title="Eşlenmemiş gelen ürün yok"
          description="Tüm gelen siparişler bir panel ürününe eşli. Yeni bir mağaza ürünü sipariş edildiğinde burada görünür."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {rows.length} eşlenmemiş mağaza ürünü — her biri gerçek bir siparişte geldi ama panelde bir
        ürüne bağlı değil.
      </p>
      <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Site</TableHead>
              <TableHead>Mağaza ürünü</TableHead>
              <TableHead className="text-right">Sipariş / Adet</TableHead>
              <TableHead>Son görülme</TableHead>
              <TableHead className="text-right">Aksiyon</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={rowKey(row)}>
                <TableCell className="text-xs text-muted-foreground">{row.siteDomain}</TableCell>
                <TableCell>
                  <div className="font-medium text-foreground">{displayName(row)}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    #{row.remoteProductId}
                    {row.remoteVariationId ? ` · varyasyon ${row.remoteVariationId}` : ''}
                  </div>
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                  {row.orderCount} sipariş · {row.lineCount} kalem
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{trDate(row.lastSeen)}</TableCell>
                <TableCell className="text-right">
                  <MapProductSheet
                    siteId={row.siteId}
                    siteDomain={row.siteDomain}
                    remoteProductId={row.remoteProductId}
                    remoteVariationId={row.remoteVariationId}
                    productName={displayName(row)}
                    products={products}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
