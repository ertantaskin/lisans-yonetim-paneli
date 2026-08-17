'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Clock, Globe, Link2Off, ShieldAlert } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { cn, formatDate, includesTr } from '../lib/utils';
import type { ProductRow } from '../lib/api';
import { productKindLabel, productTypeSummary, fulfillmentPolicyLabel } from '../lib/labels';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ProductEditSheet } from './product-edit-sheet';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

/**
 * Ürün satırı + eşleme boyutu. API `list()` ürün başına AKTİF eşlemelerin site alan adlarını
 * döndürür; alan `lib/api.ts` ProductRow'da tanımlı OLMADIĞI için (o dosya bu partide başka
 * bir işçinin) burada genişletilir. SAVUNMACI: alan gelmezse (api/admin sürüm sapması)
 * "eşleme yok" İDDİA EDİLMEZ — '—' basılır.
 */
export type ProductTableRow = ProductRow & {
  mappedSites?: string[] | null;
  mappingCount?: number | null;
};

/** Eşleme durumu — facet değeri + rozet kararının TEK kaynağı ('unknown' = alan gelmedi). */
function mappingState(row: ProductTableRow): 'mapped' | 'unmapped' | 'unknown' {
  if (!Array.isArray(row.mappedSites)) return 'unknown';
  return row.mappedSites.length > 0 ? 'mapped' : 'unmapped';
}

/** Ürün tasarım gereği mi stoksuz (stoksuz/ön sipariş) — kırmızı 0 gerçek tükenme DEĞİLDİR. */
function isStockless(row: ProductTableRow): boolean {
  return row.stockless === true;
}

/** Satış tarihi henüz gelmemiş mi (ön sipariş penceresi). */
function isPreRelease(row: ProductTableRow): boolean {
  if (!row.releaseAt) return false;
  const t = new Date(row.releaseAt).getTime();
  return Number.isFinite(t) && t > Date.now();
}

const buildColumns = (
  categories: Array<{ id: string; name: string }>,
  guides: Array<{ id: string; title: string }>,
): ColumnDef<ProductTableRow>[] => [
  {
    accessorKey: 'name',
    meta: { title: 'Ürün' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Ürün" />,
    cell: ({ row }) => (
      <Link
        href={`/products/${row.original.id}`}
        className="font-medium text-foreground underline-offset-4 hover:underline"
      >
        {row.original.name}
      </Link>
    ),
    // Arama: ürün adı VEYA SKU. Türkçe-duyarlı karşılaştırma (`includesTr`) — ham
    // `toLowerCase()` ile "İşletim"/"IŞIK" gibi kayıtlar aranınca bulunamıyordu.
    filterFn: (row, _id, value) =>
      includesTr(row.original.name, value) || includesTr(row.original.sku, value),
  },
  {
    accessorKey: 'sku',
    meta: { title: 'SKU' },
    header: 'SKU',
    cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{row.original.sku}</span>,
  },
  {
    // Kategori kolonu: ARAMA sonucunda ve "Kategorisiz" kartında ürünün hangi gruba ait
    // olduğu görünmeli (kategori kartından girildiğinde zaten bilinir ama kolon gizlenmez —
    // aynı tablo üç bağlamda kullanılıyor, koşullu kolon iki farklı tablo demek olurdu).
    id: 'category',
    accessorFn: (row) => row.categoryName ?? '',
    meta: { title: 'Kategori' },
    header: 'Kategori',
    cell: ({ row }) =>
      row.original.categoryName ? (
        <Link
          href={`/stock?category=${encodeURIComponent(row.original.categoryId ?? '')}`}
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {row.original.categoryName}
        </Link>
      ) : (
        <span className="text-xs text-muted-foreground">Kategorisiz</span>
      ),
    filterFn: (row, _id, value) =>
      (value as string[]).includes(row.original.categoryId ?? 'none'),
  },
  {
    accessorKey: 'kind',
    meta: { title: 'Tip' },
    header: 'Tip',
    // Stoksuz/ön sipariş NİTELİĞİ tip özetinde hiç yazmıyordu; oysa bu ürünlerde stok 0
    // TASARIM GEREĞİ kalıcıdır (gerçek tükenmeden ayırt edilmeli).
    cell: ({ row }) => {
      const stockless = isStockless(row.original);
      const preRelease = isPreRelease(row.original);
      return (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{productTypeSummary(row.original)}</span>
          {(stockless || preRelease) && (
            <span className="flex flex-wrap items-center gap-1">
              {stockless && (
                <Badge variant="outline" title="Stoksuz / ön sipariş — stok 0 normaldir">
                  Stoksuz / ön sipariş
                </Badge>
              )}
              {preRelease && (
                <Badge
                  variant="neutral"
                  title={`Satış tarihi: ${formatDate(row.original.releaseAt, false)}`}
                >
                  <Clock /> {formatDate(row.original.releaseAt, false)}
                </Badge>
              )}
            </span>
          )}
        </div>
      );
    },
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'fulfillmentPolicy',
    meta: { title: 'Politika' },
    header: 'Politika',
    cell: ({ row }) => (
      <span className="text-muted-foreground">{fulfillmentPolicyLabel(row.original.fulfillmentPolicy)}</span>
    ),
  },
  {
    accessorKey: 'availableStock',
    meta: { title: 'Stok' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Stok" />,
    cell: ({ row }) => {
      const s = row.original.availableStock;
      const threshold = row.original.lowStockThreshold;
      const low = threshold != null && s <= threshold;
      // Stoksuz/ön sipariş üründe 0 BEKLENEN durumdur → kırmızı alarm gösterme (aksi halde
      // stoka göre sıralanan listede tasarım gereği boş ürünler acil tedariklerle karışıyor).
      const byDesign = isStockless(row.original) || isPreRelease(row.original);
      return (
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              'font-medium tabular-nums',
              s > 0 ? 'text-success' : byDesign ? 'text-muted-foreground' : 'text-destructive',
            )}
            title={
              byDesign && s === 0
                ? 'Stoksuz / ön sipariş ürünü — stok 0 tasarım gereğidir'
                : row.original.usageMode === 'multi'
                  ? 'Satılabilir KULLANIM HAKKI toplamı (anahtar sayısı değil): çok kullanımlık ' +
                    'üründe bir anahtar birden çok hak taşır ve her anahtarın kapasitesi farklı olabilir.'
                  : 'Satılabilir stok (anahtar/hesap sayısı)'
            }
          >
            {s}
          </span>
          {/*
            BİRİM ETİKETİ — aynı kolon iki farklı şeyi sayıyor: tek kullanımlıkta ANAHTAR,
            MAK'ta KULLANIM HAKKI (1 anahtar × N hak). Çıplak sayı yan yana listelendiğinde
            "bu üründen 1002 anahtar var" diye okunuyordu. İpucu metni yetmez (görünmez).
          */}
          {row.original.usageMode === 'multi' && (
            <span className="text-xs text-muted-foreground">hak</span>
          )}
          {/* Tasarım gereği boş üründe "düşük" uyarısı da yanlış alarmdır. */}
          {low && !(byDesign && s === 0) && (
            // Badge primitifi (eskiden elle yazılmış rozet): zorunlu `ring-inset` saç teli ve
            // `rounded-full` yoktu, 10px ile panelin rozet ölçüsünün (12px) altındaydı.
            <Badge variant="warning" title={`Düşük stok (eşik ${threshold})`}>
              <ShieldAlert /> Düşük
            </Badge>
          )}
        </span>
      );
    },
  },
  {
    // Eşleme boyutu (§3): eşlemesi olmayan ürün "Stok 50, yeşil" görünüp HİÇBİR mağazada
    // satılamıyordu; sipariş satırı sessizce 'eşlenmemiş' bekliyordu. Artık listede görünür.
    id: 'mapping',
    accessorFn: (row) => mappingState(row),
    meta: { title: 'Satıldığı siteler' },
    header: 'Satıldığı siteler',
    enableSorting: false,
    cell: ({ row }) => {
      const state = mappingState(row.original);
      if (state === 'unknown') {
        // Alan gelmedi → "eşleme yok" DEME (uydurma değer yerine '—').
        return <span className="text-xs text-muted-foreground">—</span>;
      }
      if (state === 'unmapped') {
        return (
          <Badge variant="warning" title="Hiçbir mağazaya eşlenmemiş — bu ürün satılamaz">
            <Link2Off /> eşleme yok
          </Badge>
        );
      }
      const domains = row.original.mappedSites ?? [];
      const shown = domains.slice(0, 2);
      return (
        <span className="flex flex-wrap items-center gap-1" title={domains.join(', ')}>
          {shown.map((d) => (
            <span
              key={d}
              className="inline-flex max-w-[12rem] items-center gap-1 truncate rounded border border-border bg-card px-1.5 py-0.5 text-xs text-muted-foreground"
            >
              <Globe className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{d}</span>
            </span>
          ))}
          {domains.length > shown.length && (
            <span className="text-xs text-muted-foreground">+{domains.length - shown.length}</span>
          )}
        </span>
      );
    },
    filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
  },
  {
    id: 'actions',
    header: () => <span className="sr-only">Detay</span>,
    enableSorting: false,
    enableHiding: false,
    cell: ({ row }) => (
      <div className="flex items-center justify-end gap-1">
        <ProductEditSheet product={row.original} categories={categories} guides={guides} />
        <Button asChild variant="ghost" size="sm">
          <Link href={`/products/${row.original.id}`}>
            Detay <ArrowRight />
          </Link>
        </Button>
      </div>
    ),
  },
];

export function ProductsTable({
  products,
  categories = [],
  guides = [],
}: {
  products: ProductTableRow[];
  /** Satır içi "Düzenle" panelinde kategori değiştirebilmek için (`/categories` listesi). */
  categories?: Array<{ id: string; name: string }>;
  /** Aynı panelde kurulum rehberi değiştirebilmek için (`/guides` listesi). */
  guides?: Array<{ id: string; title: string }>;
}) {
  // Kategori listesi kolonlara PROP olarak girmek zorunda (düzenleme sheet'i satırda) →
  // kolonlar modül sabiti olamaz; kategori değişince yeniden kurulur.
  const columns = React.useMemo(() => buildColumns(categories, guides), [categories, guides]);

  // kind + eşleme facet seçenekleri veriden türetilir
  const facets: FacetConfig[] = React.useMemo(() => {
    const out: FacetConfig[] = [];
    const kinds = Array.from(new Set(products.map((p) => p.kind))).sort();
    if (kinds.length > 1) {
      out.push({
        columnId: 'kind',
        title: 'Tip',
        options: kinds.map((k) => ({ label: productKindLabel(k), value: k })),
      });
    }
    // Kategori faceti: yalnız GERÇEKTEN birden çok grup varsa anlamlı (tek kategoride
    // süzgeç sunmak boş bir seçim yapmaktır). "Kategorisiz" de bir seçenektir.
    const cats = new Map<string, string>();
    for (const p of products) {
      if (p.categoryId && p.categoryName) cats.set(p.categoryId, p.categoryName);
      else if (!p.categoryId) cats.set('none', 'Kategorisiz');
    }
    if (cats.size > 1) {
      out.push({
        columnId: 'category',
        title: 'Kategori',
        options: [...cats.entries()].map(([value, label]) => ({ label, value })),
      });
    }
    // Süzgeç YALNIZ alan gerçekten geldiyse sunulur (aksi halde hepsi 'unknown' olur ve
    // süzgeç "hiç eşlemesiz ürün yok" gibi yanıltıcı bir izlenim üretir).
    const hasMappingInfo = products.some((p) => Array.isArray(p.mappedSites));
    if (hasMappingInfo) {
      out.push({
        columnId: 'mapping',
        title: 'Eşleme',
        options: [
          { label: 'Eşlenmiş', value: 'mapped', icon: Globe },
          { label: 'Eşleme yok', value: 'unmapped', icon: Link2Off },
        ],
      });
    }
    return out;
  }, [products]);

  return (
    <DataTable
      columns={columns}
      data={products}
      searchColumnId="name"
      searchPlaceholder="Ürün adı veya SKU…"
      facets={facets}
      initialSorting={[{ id: 'availableStock', desc: false }]}
      /* Süzgeçler adres çubuğuna yazılır (`tq`/`tf.*`/`tsort` — sayfanın kendi `?category=`
         ve `?q=` parametreleriyle çakışmaz, bkz. data-table/url-state.ts).
         GEREKÇE (denetim bulgusu U1): bu ekranda "Görünümler" menüsü var. Sync olmadan
         operatörün tabloya yazdığı arama/facet adrese girmiyordu → `?category=X` dolu
         olduğu için menü uyarı da vermiyor, kaydedilen görünüm geri yüklendiğinde FARKLI
         bir liste geliyordu (sessiz veri kaybı sınıfı). */
      syncUrl
      emptyLabel="Ürün yok."
    />
  );
}
