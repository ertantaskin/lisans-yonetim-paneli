'use client';
import * as React from 'react';
import {
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import './meta';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { DataTablePagination } from './data-table-pagination';
import { DataTableToolbar, type FacetConfig } from './data-table-toolbar';
import { buildTableUrlQuery, parseTableUrlState } from './url-state';

/** Genel amaçlı, istemci-taraflı DataTable (sıralama/filtre/facet/sayfalama/görünürlük). */
export function DataTable<TData, TValue>({
  columns,
  data,
  searchColumnId,
  searchPlaceholder,
  facets,
  initialSorting = [],
  pageSize = 10,
  emptyLabel = 'Kayıt yok.',
  syncUrl = false,
}: {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  searchColumnId?: string;
  searchPlaceholder?: string;
  facets?: FacetConfig[];
  initialSorting?: SortingState;
  pageSize?: number;
  emptyLabel?: string;
  /**
   * Arama/facet/sıralama durumunu adres çubuğuna yaz (opt-in, bkz. `url-state.ts`).
   * Açıldığında: süzgeçli adres paylaşılabilir/yer imine eklenebilir olur ve kayıtlı
   * görünümler (§14) bu ekranda gerçekten çalışır.
   */
  syncUrl?: boolean;
}) {
  const [sorting, setSorting] = React.useState<SortingState>(initialSorting);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});

  /*
   * URL ↔ tablo durumu (yalnız `syncUrl`).
   *
   * `useSearchParams` KULLANILMIYOR: o kanca CSR-bailout'tur (her çağıran sayfa Suspense
   * sınırı ister) ve `router.replace` her tuş vuruşunda sunucu bileşenini yeniden çalıştırıp
   * veriyi yeniden çekerdi. Bunun yerine `window.history.replaceState` — Next 15'in query
   * güncellemesi için önerdiği yol: yeniden render/fetch YOK, geri tuşu kirlenmez.
   *
   * OKUMA MOUNT SONRASI: ilk render sunucununkiyle BİREBİR aynı kalmalı (hydration uyuşmazlığı
   * satırların farklı süzülmesiyle ortaya çıkardı) → URL durumu effect içinde uygulanır.
   */
  const facetColumnIds = React.useMemo(() => (facets ?? []).map((f) => f.columnId), [facets]);
  const urlReadyRef = React.useRef(!syncUrl);

  React.useEffect(() => {
    if (!syncUrl) return;
    const parsed = parseTableUrlState(window.location.search, searchColumnId, facetColumnIds);
    if (parsed.columnFilters.length > 0) setColumnFilters(parsed.columnFilters);
    if (parsed.sorting.length > 0) setSorting(parsed.sorting);
    urlReadyRef.current = true;
    // Yalnız mount'ta: sonraki değişikliklerin kaynağı tablonun kendisidir (tek yönlü akış).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncUrl]);

  React.useEffect(() => {
    // İlk okuma tamamlanmadan yazma: URL'i boş durumla EZERDİ (paylaşılan adres kaybolurdu).
    if (!syncUrl || !urlReadyRef.current) return;
    const next = buildTableUrlQuery(
      window.location.search,
      { sorting, columnFilters },
      searchColumnId,
      facetColumnIds,
    );
    if (next === window.location.search || (next === '' && window.location.search === '')) return;
    window.history.replaceState(null, '', `${window.location.pathname}${next}`);
  }, [syncUrl, sorting, columnFilters, searchColumnId, facetColumnIds]);

  const table = useReactTable({
    // Savunma: veri (ör. beklenmeyen API şekli) undefined gelse bile tablo çökmez, boş gösterir.
    data: data ?? [],
    columns,
    state: { sorting, columnFilters, columnVisibility },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    initialState: { pagination: { pageSize } },
  });

  return (
    <div>
      <DataTableToolbar
        table={table}
        searchColumnId={searchColumnId}
        searchPlaceholder={searchPlaceholder}
        facets={facets}
      />
      {/* Kart sözleşmesi (referans): rounded-xl + bg-card + shadow-xs. Eskiden yalnız
          `rounded-lg border` idi → tablo yüzeyi paneldeki diğer kartlarla aynı dilde değildi. */}
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="bg-muted/40 hover:bg-muted/40">
                {/* Başlık yüksekliği TEK KAYNAK TableHead (h-11). Burada `h-10` ile eziliyordu →
                    DataTable'lar, doğrudan <Table> kullanan ekranlardan 4px farklı görünüyordu. */}
                {hg.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  {/*
                    "HİÇ KAYIT YOK" ile "SÜZGEÇLE EŞLEŞEN YOK" AYRI cümlelerdir. Çağıranların
                    `emptyLabel`'ı veri kümesini anlatır ("Bu sitenin müşterisi yok.") — süzgeç
                    aktifken bunu basmak operatöre YALAN söyler. Risk `syncUrl` ile arttı:
                    süzgeçli bir adres artık paylaşılabiliyor/yer imine eklenebiliyor, yani
                    operatör sayfaya SÜZGEÇ AÇIKKEN girebiliyor ve boş listeyi "kayıt yok"
                    diye okuyabiliyor. Süzgeci temizleme yolu da aynı cümlede gösterilir.
                  */}
                  {table.getState().columnFilters.length > 0 && data.length > 0 ? (
                    <span className="inline-flex flex-wrap items-center justify-center gap-1.5">
                      Süzgeçle eşleşen kayıt yok.
                      <button
                        type="button"
                        onClick={() => table.resetColumnFilters()}
                        className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
                      >
                        Süzgeçleri temizle
                      </button>
                    </span>
                  ) : (
                    emptyLabel
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <DataTablePagination table={table} />
    </div>
  );
}
