'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Ban,
  CheckCircle2,
  Clock,
  ClipboardCheck,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import type { OrderRow } from '../lib/api';
import { badgeStatusLabel } from '../lib/labels';
import { fmtDateTime, includesTr } from '../lib/utils';
import { StatusBadge } from './ui/badge';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Button } from './ui/button';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

/**
 * Sipariş listesi satırı. `heldForReview` (§8) `/v1/admin/orders` yanıtında GELİR (list()
 * tüm orders kolonlarını döndürür) ama paylaşılan `OrderRow` tipinde yoktur — burada
 * OPSİYONEL genişletilir: api/admin ayrı imajlar olduğundan sürüm sapmasında alan
 * gelmeyebilir → `=== true` ile savunmacı okunur (undefined ⇒ bugünkü davranış birebir).
 */
export type OrdersTableRow = OrderRow & { heldForReview?: boolean };

/**
 * Satırın GÖSTERİLECEK durumu: held bayrağı ham durumu EZER (§8). Held sipariş DB'de
 * 'pending' durur; ham rozet "Bekliyor" derse operatör stok beklediğini sanır — oysa
 * teslimat manuel onaya bağlıdır (aksiyon /review'da). Süzgeç ile kolon AYNI değeri
 * okusun diye türetme accessor'da yapılır (facet 'İncelemede' seçeneği böyle çalışır).
 */
function displayStatus(row: OrdersTableRow): string {
  return row.heldForReview === true ? 'held_for_review' : row.status;
}

const columns: ColumnDef<OrdersTableRow>[] = [
  {
    accessorKey: 'remoteOrderId',
    meta: { title: 'Sipariş No' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Sipariş No" />,
    cell: ({ row }) => <span className="font-medium tabular-nums">{row.original.remoteOrderId}</span>,
    // Arama: sipariş no VEYA müşteri e-postası VEYA mağaza. Türkçe-duyarlı karşılaştırma
    // (`includesTr`): ham `toLowerCase()` ile "İ"/"I" içeren e-postalar bulunamıyordu.
    filterFn: (row, _id, value) =>
      includesTr(row.original.remoteOrderId, value) ||
      includesTr(row.original.customerEmail, value) ||
      includesTr(row.original.siteDomain ?? '', value),
  },
  {
    // ÇOK SİTELİ BAĞLAM: hangi mağazadan geldiği (operatör şikâyeti). Facet ile filtrelenebilir.
    // `accessorFn` — alan API'den gelmezse (sürüm sapması) '—' basılır, satır yine listelenir.
    id: 'siteDomain',
    accessorFn: (row) => row.siteDomain ?? '',
    meta: { title: 'Site' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Site" />,
    cell: ({ row }) =>
      row.original.siteDomain ? (
        <span className="whitespace-nowrap">{row.original.siteDomain}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'customerEmail',
    meta: { title: 'Müşteri' },
    header: 'Müşteri',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.customerEmail}</span>,
  },
  {
    id: 'status',
    accessorFn: displayStatus,
    meta: { title: 'Durum' },
    header: 'Durum',
    cell: ({ row }) => <StatusBadge status={displayStatus(row.original)} />,
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'createdAt',
    meta: { title: 'Tarih' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Tarih" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {fmtDateTime(row.original.createdAt)}
      </span>
    ),
    sortingFn: 'datetime',
  },
  {
    id: 'actions',
    cell: ({ row }) => (
      <div className="text-right">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/orders/${row.original.id}`}>
            Detay <ArrowRight />
          </Link>
        </Button>
      </div>
    ),
  },
];

/**
 * Durum süzgeci. ETİKETLER ELLE YAZILMAZ: `badgeStatusLabel` ile üretilir → süzgeç metni ile
 * kolondaki rozet metni yapısal olarak AYRIŞAMAZ (eskiden süzgeç "Kısmi", kolon "Kısmi teslim"
 * diyordu; operatör aynı şeyi gösterip göstermediklerinden emin olamıyordu).
 */
const statusFacet: FacetConfig = {
  columnId: 'status',
  title: 'Durum',
  options: [
    { label: badgeStatusLabel('pending'), value: 'pending', icon: Clock },
    { label: badgeStatusLabel('partial'), value: 'partial', icon: Clock },
    { label: badgeStatusLabel('fulfilled'), value: 'fulfilled', icon: CheckCircle2 },
    // §8 held: DB durumu 'pending' ama panelin YETKİLİ işareti "İncelemede" (displayStatus).
    {
      label: badgeStatusLabel('held_for_review'),
      value: 'held_for_review',
      icon: ClipboardCheck,
    },
    { label: badgeStatusLabel('revoked'), value: 'revoked', icon: Ban },
    { label: badgeStatusLabel('unmapped'), value: 'unmapped', icon: ShieldAlert },
  ],
};

/** Sunucunun döndürdüğü en yeni sipariş sayısı (API `list()` → `limit(200)`). */
const SERVER_LIMIT = 200;

export function OrdersTable({ orders }: { orders: OrdersTableRow[] }) {
  // Mağaza facet'i VERİDEN türetilir (sabit liste değil): yalnız gerçekten sipariş gelmiş
  // mağazalar listelenir. TEK mağaza varsa facet GÖSTERİLMEZ — tek seçenekli filtre gürültüdür.
  const facets = React.useMemo<FacetConfig[]>(() => {
    const domains = Array.from(
      new Set(orders.map((o) => o.siteDomain).filter((d): d is string => !!d)),
    ).sort((a, b) => a.localeCompare(b, 'tr'));
    return domains.length > 1
      ? [
          statusFacet,
          {
            columnId: 'siteDomain',
            title: 'Site',
            options: domains.map((d) => ({ label: d, value: d })),
          },
        ]
      : [statusFacet];
  }, [orders]);

  /**
   * DÜRÜSTLÜK: sunucu yalnız EN YENİ 200 siparişi döndürür ve bu tablonun arama/süzgeç/
   * sıralaması TAMAMEN istemci-taraflıdır → hepsi bu pencerede çalışır. Sessiz kalırsak:
   * (a) sayfalamadaki "200 kayıt" toplam sipariş sanılır, (b) bir hafta önceki siparişi
   * arayan operatör "Kayıt yok." görüp siparişin panele hiç düşmediğini sanar, (c) mağaza
   * süzgeci yalnız bu penceredeki mağazaları listelediği için düşük hacimli mağaza HİÇ
   * görünmez. Pencere doluysa açıkça söylenir (/pending ve /quarantine ile aynı disiplin).
   */
  const truncated = orders.length >= SERVER_LIMIT;

  return (
    <div className="space-y-3">
      {truncated && (
        <Alert variant="info">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>En yeni {SERVER_LIMIT} sipariş gösteriliyor</AlertTitle>
            <AlertDescription>
              Arama, durum ve mağaza süzgeçleri yalnız bu pencere üzerinde çalışır — daha eski
              bir sipariş listede çıkmıyorsa panelde yok demek DEĞİLDİR. Belirli bir siparişi
              arıyorsanız mağaza panelinden sipariş numarasıyla gelin ya da Bekleyen Teslimatlar /
              Müşteriler ekranından daraltarak ilerleyin.
            </AlertDescription>
          </div>
        </Alert>
      )}
      <DataTable
        columns={columns}
        data={orders}
        searchColumnId="remoteOrderId"
        searchPlaceholder="Sipariş no, e-posta veya site…"
        facets={facets}
        initialSorting={[{ id: 'createdAt', desc: true }]}
        emptyLabel={
          truncated
            ? `Bu pencerede kayıt yok — yalnız en yeni ${SERVER_LIMIT} sipariş yüklendi, daha eskisi listede değil.`
            : 'Kayıt yok.'
        }
      />
    </div>
  );
}
