'use client';
import Link from 'next/link';
import * as React from 'react';
import { ArrowRight } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { isAutoReceipt } from '@lisans/shared';
import { supplyStatusLabel } from '@/lib/labels';
import type { PurchaseOrderRow } from '@/app/purchase-orders/queries';
import { Badge, SupplyStatusBadge } from './ui/badge';
import { Button } from './ui/button';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

/**
 * PO durum rozeti — panelin TEK tedarik rozetine (`SupplyStatusBadge`) devredilir.
 * Burada yerel bir sözlük vardı: etiketleri ELLE küçük harf yazıyor (sözlüğü atlıyor),
 * ikon basmıyor ve 'ordered'ı gri gösteriyordu (ürün detayında amber). Dışa açık ad
 * korunur — çağrı yerleri (`/purchase-orders/[id]`) değişmeden çalışır.
 */
export function POStatusBadge({ status, className }: { status: string; className?: string }) {
  return <SupplyStatusBadge status={status} className={className} />;
}

/** ISO tarihi kısa tr-TR biçimler. */
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('tr-TR', { dateStyle: 'short' });
}

const columns: ColumnDef<PurchaseOrderRow>[] = [
  {
    accessorKey: 'supplierName',
    meta: { title: 'Tedarikçi' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Tedarikçi" />,
    cell: ({ row }) => <span className="font-medium">{row.original.supplierName}</span>,
    filterFn: (row, _id, value) => {
      const q = String(value).toLowerCase();
      return (
        row.original.supplierName.toLowerCase().includes(q) ||
        row.original.productSku.toLowerCase().includes(q) ||
        row.original.productName.toLowerCase().includes(q)
      );
    },
  },
  {
    id: 'product',
    accessorFn: (r) => `${r.productSku} ${r.productName}`,
    meta: { title: 'Ürün' },
    header: 'Ürün',
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        <span className="font-mono text-xs text-foreground/70">{row.original.productSku}</span>{' '}
        {row.original.productName}
      </span>
    ),
    enableSorting: false,
  },
  {
    accessorKey: 'status',
    meta: { title: 'Durum' },
    header: 'Durum',
    cell: ({ row }) => (
      <span className="flex flex-wrap items-center gap-1.5">
        <POStatusBadge status={row.original.status} />
        {/*
          OTOMATİK EMİR (§12): bu emri operatör açmadı — Stok Girişi ekranı, girilen mala
          maliyet/izlenebilirlik defteri tutmak için türetti. Mal ZATEN girilmiştir, yani
          teslim alınacak bir şey yoktur; uç ikinci teslim almayı reddeder. İşaret olmadan
          operatör satırı elle açılmış açık emir sanıp "Teslim Al" deniyor ve hataya çarpıyordu.
        */}
        {isAutoReceipt(row.original.notes) && (
          <Badge
            variant="outline"
            title="Stok girişinden otomatik oluşturuldu — teslim alma adımı yoktur, mal zaten girildi."
          >
            Otomatik
          </Badge>
        )}
      </span>
    ),
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    id: 'qty',
    meta: { title: 'Teslim' },
    header: 'Teslim',
    accessorFn: (r) => r.qtyReceived,
    cell: ({ row }) => (
      <span className="tabular-nums">
        {row.original.qtyReceived}/{row.original.qtyOrdered}
      </span>
    ),
  },
  {
    accessorKey: 'eta',
    meta: { title: 'ETA' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="ETA" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">{fmtDate(row.original.eta)}</span>
    ),
    sortingFn: 'datetime',
  },
  {
    id: 'actions',
    header: () => <span className="sr-only">Aksiyonlar</span>,
    cell: ({ row }) => (
      <div className="text-right">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/purchase-orders/${row.original.id}`}>
            Detay <ArrowRight />
          </Link>
        </Button>
      </div>
    ),
    enableSorting: false,
    enableHiding: false,
  },
];

const facets: FacetConfig[] = [
  {
    columnId: 'status',
    title: 'Durum',
    // Etiketler TEK KAYNAKTAN: elle yazıldığında rozetle ayrışıyordu ("Kısmi teslim" ↔ "Kısmi").
    options: ['draft', 'ordered', 'partial', 'received', 'cancelled'].map((value) => ({
      label: supplyStatusLabel(value),
      value,
    })),
  },
];

export function PurchaseOrdersTable({ orders }: { orders: PurchaseOrderRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={orders}
      searchColumnId="supplierName"
      searchPlaceholder="Tedarikçi veya ürün ara…"
      facets={facets}
      initialSorting={[{ id: 'eta', desc: false }]}
      emptyLabel="Henüz satın alma emri yok."
    />
  );
}
