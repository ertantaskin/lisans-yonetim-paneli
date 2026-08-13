'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Store, PackageSearch, Search, Trash2, TriangleAlert } from 'lucide-react';
import type { CatalogRow, CatalogSummaryRow, ProductRow } from '../lib/api';
import { removeMappingWithResult } from '../app/mappings/actions';
import { storeProductKindLabel } from '../lib/labels';
import { includesTr } from '../lib/utils';
import { useAnnouncer } from './a11y/announcer';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { useConfirm } from './ui/confirm';
import { Input } from './ui/input';
import { Combobox } from './ui/combobox';
import { Card } from './ui/card';
import { EmptyState } from './ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { MapProductSheet } from './map-product-sheet';

/**
 * Katalog satırı + varyasyon SUNUM bayrakları.
 *
 * API (`products.service.listCatalog`) bu üç alanı zaten döndürüyor ama paylaşılan `CatalogRow`
 * tipi henüz taşımıyor → burada opsiyonel olarak genişletilir. Savunmacı okunur: alan gelmezse
 * ekran bugünkü davranışa düşer (api ve admin ayrı imajlar, sürüm sapması olabilir).
 */
export type CatalogRowView = CatalogRow & {
  /** Varyasyonlu ürünün EBEVEYN satırı mı — bu satır tasarım gereği hiç eşleşmez. */
  isVariableParent?: boolean;
  /** Bu mağaza ürününün toplam varyasyon sayısı. */
  variationCount?: number;
  /** Kaç varyasyonu panelde eşli. */
  mappedVariationCount?: number;
};

/**
 * Eşlemeyi KALDIR butonu (§3). Onay ister (yanlışlıkla kaldırmayı önle); kaldırınca bu mağaza
 * ürününün siparişleri artık panel ürünü çözemez → beklemede kalır (operatör yeniden eşleyebilir).
 * Hata SESSİZCE YUTULMAZ: başarısızlıkta satırın altında gerekçe gösterilir ve okuyucuya duyurulur
 * (eskiden hata yutuluyordu → operatör "kaldırdım" sanıyor, eşleme yerinde kalıyordu).
 */
function RemoveMappingButton({ mappingId, productLabel }: { mappingId: string; productLabel: string }) {
  const router = useRouter();
  const announce = useAnnouncer();
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  const remove = async () => {
    const ok = await confirm({
      title: 'Eşleme kaldırılsın mı?',
      description: `“${productLabel}” eşlemesi silinir. Bu mağaza ürününün YENİ siparişleri artık panel ürününü çözemez ve beklemede kalır (yanlış ürün teslim edilmez). İstediğiniz zaman yeniden eşleyebilirsiniz.`,
      tone: 'danger',
      confirmLabel: 'Eşlemeyi kaldır',
    });
    if (!ok) return;
    setError(null);
    start(async () => {
      const res = await removeMappingWithResult(mappingId);
      if (res.ok) {
        announce(`${productLabel} eşlemesi kaldırıldı`);
        router.refresh();
      } else {
        const message = res.error ?? 'Eşleme kaldırılamadı';
        setError(message);
        announce(message, { assertive: true });
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      {dialog}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => void remove()}
        aria-label={`${productLabel} eşlemesini kaldır`}
      >
        <Trash2 /> {pending ? 'Kaldırılıyor…' : 'Kaldır'}
      </Button>
      {error && (
        <span className="flex items-center gap-1 text-xs text-destructive">
          <TriangleAlert className="size-3.5" aria-hidden /> {error}
        </span>
      )}
    </div>
  );
}

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
function rowKey(row: CatalogRowView): string {
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
  rows: CatalogRowView[];
  products: ProductRow[];
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const selected = sites.find((s) => s.siteId === siteId);

  const filtered = React.useMemo(() => {
    // Türkçe-duyarlı arama: ham toLowerCase() "İŞLETİM"/"ışık" gibi kayıtları sessizce
    // bulamıyordu (panelin diğer tablolarındaki includesTr deseni).
    if (!query.trim()) return rows;
    return rows.filter((r) => includesTr(`${r.name} ${r.sku ?? ''} ${r.remoteProductId}`, query));
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
                  filtered.map((row) => {
                    // [G9] Varyasyonlu ürünün EBEVEYN satırı hiçbir zaman eşleşmez (sipariş
                    // satırı daima bir varyasyona düşer, eşleme varyasyon-özel kurulur). Bunu
                    // kırmızı "eşlenmemiş" göstermek sonsuza dek sönmeyen bir alarm üretiyor ve
                    // operatörü alarmı susturmak için TEHLİKELİ bir ürün-seviyesi catch-all
                    // eşleme kurmaya itiyordu → nötr "varyasyonları eşleyin (N/M eşli)".
                    const variableParent = row.isVariableParent === true && !row.mapped;
                    const mappedVar = row.mappedVariationCount ?? 0;
                    const totalVar = row.variationCount ?? 0;
                    return (
                    <TableRow key={rowKey(row)}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">{row.name}</span>
                          {row.kind && (
                            <Badge variant="outline" className="shrink-0">
                              {storeProductKindLabel(row.kind)}
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
                            {row.mappedProductName ?? 'Eşli'}
                            {row.bundleQty && row.bundleQty > 1 ? ` · paket ${row.bundleQty}` : ''}
                          </Badge>
                        ) : variableParent ? (
                          <span className="flex flex-col items-start gap-0.5">
                            <Badge variant="neutral">
                              {/* Sayaç yalnız GERÇEK veri varken basılır — alan gelmediyse
                                  "0/0 eşli" gibi uydurma bir kırılım gösterilmez. */}
                              Varyasyonları eşleyin
                              {totalVar > 0 ? ` (${mappedVar}/${totalVar} eşli)` : ''}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              Bu satır yalnızca ürün başlığıdır — eşlenmemesi bir eksik değildir.
                            </span>
                          </span>
                        ) : (
                          <Badge variant="outline">Eşlenmemiş</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.mapped && row.mappingId ? (
                          <div className="flex items-center justify-end gap-1">
                            <MapProductSheet
                              mode="edit"
                              siteId={selected.siteId}
                              siteDomain={selected.domain}
                              remoteProductId={row.remoteProductId}
                              remoteVariationId={row.remoteVariationId}
                              productName={row.name}
                              products={products}
                              mappingId={row.mappingId}
                              currentProductId={row.mappedProductId}
                              currentBundleQty={row.bundleQty}
                            />
                            <RemoveMappingButton mappingId={row.mappingId} productLabel={row.name} />
                          </div>
                        ) : (
                          <MapProductSheet
                            siteId={selected.siteId}
                            siteDomain={selected.domain}
                            remoteProductId={row.remoteProductId}
                            remoteVariationId={row.remoteVariationId}
                            productName={row.name}
                            products={products}
                            // Ebeveyn satırında eşleme MEŞRU ama VARSAYILAN eylem değil →
                            // ikincil ton + niyeti açık eden etiket.
                            {...(variableParent
                              ? {
                                  triggerVariant: 'ghost' as const,
                                  triggerLabel: 'Yine de ürün-seviyesi eşle',
                                }
                              : {})}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
