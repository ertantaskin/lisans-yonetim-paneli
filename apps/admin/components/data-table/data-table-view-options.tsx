'use client';
import type { Table } from '@tanstack/react-table';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

/** Kolon görünürlüğü menüsü. */
export function DataTableViewOptions<TData>({ table }: { table: Table<TData> }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* `hidden lg:flex` DEĞİL: geniş tablolarda kolon gizlemek dar ekranın TEK kaçış
            yoluydu ve tam da orada kapalıydı. 375px'te de sığıyor (arama 176px + ~100px). */}
        <Button variant="outline" size="sm" className="ml-auto flex h-8">
          <SlidersHorizontal /> Görünüm
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Kolonlar</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {table
          .getAllColumns()
          .filter((c) => typeof c.accessorFn !== 'undefined' && c.getCanHide())
          .map((c) => (
            <DropdownMenuCheckboxItem
              key={c.id}
              checked={c.getIsVisible()}
              onCheckedChange={(v) => c.toggleVisibility(!!v)}
              className="capitalize"
            >
              {c.columnDef.meta?.title ?? c.id}
            </DropdownMenuCheckboxItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
