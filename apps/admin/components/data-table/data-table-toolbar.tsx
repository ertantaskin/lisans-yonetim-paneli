'use client';
import type { Table } from '@tanstack/react-table';
import { X } from 'lucide-react';
import { Button } from '../ui/button';
import { SearchInput } from '../ui/search-input';
import { DataTableViewOptions } from './data-table-view-options';
import { DataTableFacetedFilter, type FacetOption } from './data-table-faceted-filter';

export interface FacetConfig {
  columnId: string;
  title: string;
  options: FacetOption[];
}

/** Toolbar: arama + faceted filtreler + sıfırla + kolon görünürlüğü. */
export function DataTableToolbar<TData>({
  table,
  searchColumnId,
  searchPlaceholder = 'Ara…',
  facets = [],
}: {
  table: Table<TData>;
  searchColumnId?: string;
  searchPlaceholder?: string;
  facets?: FacetConfig[];
}) {
  const isFiltered = table.getState().columnFilters.length > 0;
  const searchCol = searchColumnId ? table.getColumn(searchColumnId) : undefined;

  return (
    <div className="flex items-center justify-between gap-2 pb-3">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        {searchCol && (
          <SearchInput
            ariaLabel={searchPlaceholder}
            placeholder={searchPlaceholder}
            value={(searchCol.getFilterValue() as string) ?? ''}
            onValueChange={(v) => searchCol.setFilterValue(v)}
            className="w-44 lg:w-72"
          />
        )}
        {facets.map((f) => {
          const col = table.getColumn(f.columnId);
          return col ? (
            <DataTableFacetedFilter key={f.columnId} column={col} title={f.title} options={f.options} />
          ) : null;
        })}
        {isFiltered && (
          <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => table.resetColumnFilters()}>
            Sıfırla <X />
          </Button>
        )}
      </div>
      <DataTableViewOptions table={table} />
    </div>
  );
}
