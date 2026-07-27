'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Store, PackageSearch, Search } from 'lucide-react';
import type { CatalogRow, CatalogSummaryRow, ProductRow } from '../lib/api';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { Combobox } from './ui/combobox';
import { Card } from './ui/card';
import { EmptyState } from './ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { MapProductSheet } from './map-product-sheet';

/** ISO → tr-TR gün/ay/yıl saat:dakika (geçersiz/null ise em-dash). */
function trDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('tr-TR', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

/** Aynı remoteProductId farklı varyasyonlarda olabilir → ürün+varyasyon ile benzersiz anahtar. */
function rowKey(row: CatalogRow): string {
  return `${row.remoteProductId}:${row.remoteVariationId ?? ''}`;
}

/**
 * Site Kataloğu (proaktif eşleme, §3). Operatör bir site seçer → o mağazanın senkronlanmış TÜM
 * ürünlerini ADIYLA görür ve herhangi birini bir sipariş beklemeden panel ürününe eşler (reaktif
 * "Eşlenmemiş Gelen Ürünler" tablosunu tamamlar). Mağaza ürün ID'si katalog verisinden gelir →
 * operatör ID YAZMAZ. Site seçimi `/mappings?site=<id>` ile sunucuya gider (katalog orada çekilir).
 */
export function CatalogTable({
  sites,
  siteId,
  rows,
  products,
}: {
  sites: CatalogSummaryRow[];
  siteId?: string;
  rows: CatalogRow[];
  products: ProductRow[];
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const selected = sites.find((s) => s.siteId === siteId);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      `${r.name} ${r.sku ?? ''} ${r.remoteProductId}`.toLowerCase().includes(q),
    );
  }, [rows, query]);

  return (
    <div className="space-y-4">
      {/* Site seçici — hangi mağazanın kataloğunu proaktif eşleyeceğiz. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Combobox
          ariaLabel="Katalog sitesi"
          allowClear
          clearLabel="— seçimi kaldır —"
          placeholder="— site seçin —"
          defaultValue={siteId ?? ''}
          items={sites.map((s) => ({
            value: s.siteId,
            label: s.domain,
            hint: `${s.productCount} ürün · son senkron ${trDateTime(s.lastSyncedAt)}`,
            keywords: [s.domain],
          }))}
          searchPlaceholder="Site alan adı ara…"
          emptyText="Site bulunamadı"
          className="w-full sm:w-96"
          onValueChange={(v) =>
            router.push(v ? `/mappings?site=${encodeURIComponent(v)}` : '/mappings')
          }
        />
        {selected && (
          <p className="shrink-0 text-xs text-muted-foreground">
            Son senkron: {trDateTime(selected.lastSyncedAt)} · {selected.productCount} ürün
          </p>
        )}
      </div>

      {!selected ? (
        <Card className="p-0">
          <EmptyState
            icon={Store}
            title="Bir site seçin."
            description="Bir mağaza seçin — o sitenin senkronlanmış tüm ürünlerini görüp sipariş beklemeden panel ürününe eşleyebilirsiniz."
          />
        </Card>
      ) : selected.productCount === 0 || rows.length === 0 ? (
        <Card className="p-0">
          <EmptyState
            icon={PackageSearch}
            title="Bu sitenin kataloğu boş"
            description="Bu sitenin kataloğu boş — WordPress'te 'Ayarlar → Ürünleri Panele Aktar' ile senkronlayın."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {/* İstemci-taraflı arama (ad/SKU/mağaza ID). */}
          <div className="relative w-full sm:max-w-sm">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ürün adı, SKU veya mağaza ID ara…"
              aria-label="Katalog ürünü ara"
              className="pl-9"
            />
          </div>

          <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mağaza ürünü</TableHead>
                  <TableHead>Durum</TableHead>
                  <TableHead className="text-right">Aksiyon</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-8 text-center text-xs text-muted-foreground">
                      Aramaya uyan ürün yok.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((row) => (
                    <TableRow key={rowKey(row)}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">{row.name}</span>
                          {row.kind && (
                            <Badge variant="outline" className="shrink-0">
                              {row.kind}
                            </Badge>
                          )}
                        </div>
                        <div className="font-mono text-xs text-muted-foreground">
                          #{row.remoteProductId}
                          {row.remoteVariationId ? ` · varyasyon ${row.remoteVariationId}` : ''}
                          {row.sku ? ` · SKU ${row.sku}` : ''}
                        </div>
                      </TableCell>
                      <TableCell>
                        {row.mapped ? (
                          <Badge variant="success">
                            {row.mappedProductName ?? 'eşli'}
                            {row.bundleQty && row.bundleQty > 1 ? ` · paket ${row.bundleQty}` : ''}
                          </Badge>
                        ) : (
                          <Badge variant="warning">eşlenmemiş</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.mapped ? (
                          <span className="text-xs text-muted-foreground">eşli</span>
                        ) : (
                          <MapProductSheet
                            siteId={selected.siteId}
                            siteDomain={selected.domain}
                            remoteProductId={row.remoteProductId}
                            remoteVariationId={row.remoteVariationId}
                            productName={row.name}
                            products={products}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
