'use client';
import { PackageSearch } from 'lucide-react';
import type { ProductRow, UnmappedRow } from '../lib/api';
import { ActivateMappingButton } from '../app/mappings/activate-mapping-button';
import { mappingStateLabel } from '../lib/labels';
import { Badge } from './ui/badge';
import { Card } from './ui/card';
import { EmptyState } from './ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { MapProductSheet } from './map-product-sheet';

/**
 * Satır + PASİF eşleme bilgisi (API `products.service.listUnmapped` bu alanları döndürür ama
 * paylaşılan `UnmappedRow` tipi henüz taşımıyor → burada opsiyonel genişletme; alan gelmezse
 * ekran bugünkü davranışa düşer — api ve admin ayrı imajlar, sürüm sapması olabilir).
 *
 * NEDEN: eşleme PASİFken satır bu listeye girmeye devam eder (teslimat yapılamıyor, doğru) ama
 * "Eşle" 409 verir (aynı anahtara ikinci eşleme kurulamaz) → operatör çıkmaz sokakta kalıyordu.
 */
export type UnmappedRowView = UnmappedRow & {
  /** Pasif eşlemenin id'si (varsa). */
  mappingId?: string | null;
  mappedProductName?: string | null;
  /** `null`/alan yok = hiç eşleme yok · `false` = eşleme var ama pasif. `true` HİÇ dönmez. */
  mappingActive?: boolean | null;
};

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
export function UnmappedTable({
  rows,
  products,
}: {
  rows: UnmappedRowView[];
  products: ProductRow[];
}) {
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
      {/* Kart sözleşmesi tek kaynaktan (Card). Dıştaki `overflow-x-auto` ÖLÜ kodtu: yatay
          kaydırma ui/table.tsx'in İÇ sarmalayıcısından geliyor; burada gereken tek şey
          yuvarlak köşelerin kırpılması. */}
      <Card className="overflow-hidden">
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
            {rows.map((row) => {
              // Eşleme VAR ama PASİF → "Eşle" 409 verir; doğru eylem etkinleştirmektir.
              const passiveMapping = row.mappingActive === false && !!row.mappingId;
              return (
              <TableRow key={rowKey(row)}>
                {/* Kolonun TEK içeriği olan birincil veri 14px kalır (tablodan miras text-sm);
                    muted ton bağlam kolonu olduğunu anlatmaya yeter — 12px sözleşmenin altıydı. */}
                <TableCell className="text-muted-foreground">{row.siteDomain}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{displayName(row)}</span>
                    {/* attention (mor) = insan kararı bekliyor — katalog tablosuyla AYNI ton. */}
                    {passiveMapping && (
                      <Badge variant="attention">{mappingStateLabel(false)}</Badge>
                    )}
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">
                    #{row.remoteProductId}
                    {row.remoteVariationId ? ` · varyasyon ${row.remoteVariationId}` : ''}
                  </div>
                  {passiveMapping && (
                    <div className="text-xs text-muted-foreground">
                      {row.mappedProductName
                        ? `“${row.mappedProductName}” eşlemesi kapalı`
                        : 'Eşleme kapalı'}{' '}
                      — bu yüzden teslim edilmiyor. Etkinleştirin.
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {row.orderCount} sipariş · {row.lineCount} kalem
                </TableCell>
                <TableCell className="text-muted-foreground">{trDate(row.lastSeen)}</TableCell>
                <TableCell className="text-right">
                  {passiveMapping ? (
                    <ActivateMappingButton
                      mappingId={row.mappingId!}
                      label={displayName(row)}
                      siteId={row.siteId}
                      remoteProductId={row.remoteProductId}
                      remoteVariationId={row.remoteVariationId}
                    />
                  ) : (
                    <MapProductSheet
                      siteId={row.siteId}
                      siteDomain={row.siteDomain}
                      remoteProductId={row.remoteProductId}
                      remoteVariationId={row.remoteVariationId}
                      productName={displayName(row)}
                      products={products}
                    />
                  )}
                </TableCell>
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
