'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Ban,
  CheckCircle2,
  Clock,
  Globe,
  Mail,
  MessageSquare,
  Reply,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import type { ReplacementRow } from '../app/support/queries';
import { cn, fmtDateTime, includesTr } from '../lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';
import {
  ABUSE_HIGH,
  ABUSE_WARN,
  SupportDetailSheet,
  SupportStatusBadge,
  WarrantyBadge,
  abuseText,
  agoText,
} from './support/support-detail';

/*
 * Destek kuyruğu (§13) — "işlenebilir" liste.
 *
 * Kullanıcı şikâyeti: "admin tarafında biraz karışık duruyor, CEVAP VERME GİBİ BİR ŞANSIMIZ
 * OLMUYOR". Çözüm: (a) kuyruk ÖNCELİĞE göre sıralanır (yanıt bekleyen en üstte), (b) her satır
 * tek tıkla DETAY PANELİNİ açar — operatör ekrandan çıkmadan okur, yanıtlar ve karar verir.
 *
 * Suistimal göstergesi (90 günlük talep sayısı) yalnız İŞARETTİR: panel hiçbir talebi otomatik
 * engellemez/reddetmez (§15 "sistem önerir, insan onaylar").
 */

// ── Öncelik sıralaması ──────────────────────────────────────────────────────
// 0: müşteri yazdı, adminin görünür yanıtı yok → en üstte (operatörün gerçek borcu)
// 1: açık · 2: bilgi bekleniyor · 3: kapanmış (onaylandı/reddedildi)
const STATUS_RANK: Record<string, number> = {
  open: 1,
  info_requested: 2,
  approved: 3,
  rejected: 3,
};

function rankOf(r: ReplacementRow): number {
  return r.unansweredByAdmin ? 0 : (STATUS_RANK[r.status] ?? 2);
}

/** Son hareket zamanı (yazışma varsa son mesaj, yoksa talep tarihi). */
function activityAt(r: ReplacementRow): number {
  const t = new Date(r.lastMessageAt ?? r.createdAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

function byPriority(a: ReplacementRow, b: ReplacementRow): number {
  return rankOf(a) - rankOf(b) || activityAt(b) - activityAt(a);
}

// ── Kuyruk kapsamı (varsayılan filtre) ──────────────────────────────────────
type Scope = 'queue' | 'unanswered' | 'all';

const SCOPES: { key: Scope; label: string; hint: string }[] = [
  { key: 'queue', label: 'Bekleyen kuyruk', hint: 'Açık + bilgi bekleyen talepler' },
  { key: 'unanswered', label: 'Yanıt bekleyen', hint: 'Müşteri yazdı, henüz yanıtlanmadı' },
  { key: 'all', label: 'Tümü', hint: 'Kapanmış talepler dahil' },
];

function inScope(r: ReplacementRow, scope: Scope): boolean {
  if (scope === 'all') return true;
  if (scope === 'unanswered') return r.unansweredByAdmin;
  return r.status === 'open' || r.status === 'info_requested';
}

// ── Küçük hücre parçaları ───────────────────────────────────────────────────

/**
 * Göreli zaman — İLK render'da mutlak tarih basar, mount'tan sonra göreliye döner.
 * Neden: `relativeTime` `Date.now()` okur; sunucu ve istemci farklı anlarda hesaplayınca
 * hydration uyuşmazlığı üretiyordu. Mutlak tarih sabit timezone ile deterministiktir.
 */
function RelativeTime({ iso }: { iso: string | null }) {
  const [rel, setRel] = React.useState<string | null>(null);
  React.useEffect(() => {
    setRel(iso ? agoText(iso) : null);
  }, [iso]);
  if (!iso) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="tabular-nums text-muted-foreground" title={fmtDateTime(iso)}>
      {rel ?? fmtDateTime(iso)}
    </span>
  );
}

/** Suistimal İŞARETİ (≥3 uyarı, ≥5 kırmızı) — otomatik yaptırım YOK, yalnız bilgi. */
function AbuseBadge({ count }: { count: number }) {
  if (count < ABUSE_WARN) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Badge variant={count >= ABUSE_HIGH ? 'danger' : 'warning'}>
            <TriangleAlert /> 90 günde {count} talep
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{abuseText(count)}</TooltipContent>
    </Tooltip>
  );
}

// ── Kolonlar ────────────────────────────────────────────────────────────────

function buildColumns(onOpen: (id: string) => void): ColumnDef<ReplacementRow>[] {
  return [
    {
      accessorKey: 'status',
      meta: { title: 'Durum' },
      header: 'Durum',
      cell: ({ row }) => <SupportStatusBadge status={row.original.status} />,
      filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
    },
    {
      accessorKey: 'customerEmail',
      meta: { title: 'Müşteri' },
      header: 'Müşteri',
      cell: ({ row }) => (
        <div className="flex max-w-[16rem] flex-col items-start gap-1">
          <span className="w-full truncate text-foreground" title={row.original.customerEmail}>
            {row.original.customerEmail || '—'}
          </span>
          <AbuseBadge count={row.original.customerRequestCount90d} />
        </div>
      ),
    },
    {
      accessorKey: 'remoteOrderId',
      meta: { title: 'Sipariş' },
      header: 'Sipariş',
      cell: ({ row }) =>
        row.original.orderId ? (
          <Link
            href={`/orders/${row.original.orderId}`}
            className="font-medium tabular-nums text-primary underline-offset-2 hover:underline"
            title="Sipariş detayına git"
          >
            {row.original.remoteOrderId ? `#${row.original.remoteOrderId}` : 'Siparişi aç'}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      // Tek arama kutusu: müşteri e-postası / sipariş no / mağaza / ürün / talep metni.
      // `includesTr`: ham toLowerCase() Türkçe "İ"/"I" içeren ürün-mağaza adında sessizce
      // sonuç bulamıyordu (panel genelindeki desen).
      filterFn: (row, _id, value) => {
        const q = String(value).trim();
        if (!q) return true;
        const r = row.original;
        return (
          includesTr(r.remoteOrderId ?? '', q) ||
          includesTr(r.customerEmail, q) ||
          includesTr(r.reason, q) ||
          includesTr(r.siteDomain ?? '', q) ||
          includesTr(r.productName ?? '', q) ||
          includesTr(r.productSku ?? '', q)
        );
      },
    },
    {
      // ÇOK SİTELİ BAĞLAM: mağaza sipariş no'ları sitelere göre ÇAKIŞIR (#1024 iki sitede olabilir)
      // → talebin hangi mağazadan geldiği karar ekranında görünmeli. `accessorFn` ile alan
      // gelmezse (sürüm sapması) satır yine listelenir, hücre '—' basar.
      id: 'siteDomain',
      accessorFn: (row) => row.siteDomain ?? '',
      meta: { title: 'Site' },
      header: 'Site',
      cell: ({ row }) =>
        row.original.siteDomain ? (
          <span
            className="inline-flex max-w-[12rem] items-center gap-1.5 truncate text-xs text-muted-foreground"
            title={row.original.siteDomain}
          >
            <Globe className="size-3.5 shrink-0" aria-hidden />
            {row.original.siteDomain}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      enableSorting: false,
      filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
    },
    {
      // "Onayla" AYNI üründen taze lisans atar → hangi üründe stok gerektiği karar anında görünsün.
      id: 'productName',
      accessorFn: (row) => row.productName ?? '',
      meta: { title: 'Ürün' },
      header: 'Ürün',
      cell: ({ row }) => {
        const { productId, productName, productSku } = row.original;
        if (!productName) return <span className="text-muted-foreground">—</span>;
        return (
          <div className="flex max-w-[14rem] flex-col items-start">
            {productId ? (
              <Link
                href={`/products/${productId}`}
                className="w-full truncate text-primary underline-offset-2 hover:underline"
                title={`${productName} — ürün detayına git`}
              >
                {productName}
              </Link>
            ) : (
              <span className="w-full truncate text-foreground" title={productName}>
                {productName}
              </span>
            )}
            {productSku && (
              <span className="truncate text-xs text-muted-foreground">{productSku}</span>
            )}
          </div>
        );
      },
      enableSorting: false,
    },
    {
      accessorKey: 'reason',
      meta: { title: 'Talep' },
      header: 'Talep',
      cell: ({ row }) => (
        <button
          type="button"
          onClick={() => onOpen(row.original.id)}
          title={row.original.reason}
          className="block max-w-[22rem] truncate text-left text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {row.original.reason || '—'}
        </button>
      ),
      enableSorting: false,
    },
    {
      accessorKey: 'withinWarranty',
      meta: { title: 'Garanti' },
      header: 'Garanti',
      cell: ({ row }) => <WarrantyBadge within={row.original.withinWarranty} />,
      filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
    },
    {
      accessorKey: 'unansweredByAdmin',
      meta: { title: 'Yazışma' },
      header: 'Yazışma',
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="flex flex-col items-start gap-1">
            {r.unansweredByAdmin && (
              <Badge variant="warning">
                <Reply /> Yanıt bekliyor
              </Badge>
            )}
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <MessageSquare className="size-3.5" aria-hidden />
              <span className="tabular-nums">{r.messageCount}</span> mesaj
              {r.lastMessageAt && (
                <>
                  <span aria-hidden>·</span>
                  <RelativeTime iso={r.lastMessageAt} />
                </>
              )}
            </span>
          </div>
        );
      },
      filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
    },
    {
      accessorKey: 'createdAt',
      meta: { title: 'Oluşturma' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Oluşturma" />,
      cell: ({ row }) => <RelativeTime iso={row.original.createdAt} />,
      sortingFn: 'datetime',
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Aç</span>,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <Button
            variant={row.original.unansweredByAdmin ? 'default' : 'outline'}
            size="sm"
            onClick={() => onOpen(row.original.id)}
            aria-label={`${row.original.customerEmail} talebini aç`}
          >
            {row.original.unansweredByAdmin ? <Reply /> : <MessageSquare />}
            {row.original.unansweredByAdmin ? 'Yanıtla' : 'İncele'}
          </Button>
        </div>
      ),
      enableSorting: false,
      enableHiding: false,
    },
  ];
}

/** Sabit facet'ler — site facet'i VERİDEN türetilir (aşağıda, bileşen içinde). */
const baseFacets: FacetConfig[] = [
  {
    columnId: 'status',
    title: 'Durum',
    options: [
      { label: 'Açık', value: 'open', icon: Clock },
      { label: 'Bilgi bekleniyor', value: 'info_requested', icon: Mail },
      { label: 'Onaylandı', value: 'approved', icon: CheckCircle2 },
      { label: 'Reddedildi', value: 'rejected', icon: Ban },
    ],
  },
  {
    columnId: 'withinWarranty',
    title: 'Garanti',
    options: [
      { label: 'Garanti içi', value: 'true', icon: ShieldCheck },
      { label: 'Garanti dışı', value: 'false', icon: TriangleAlert },
    ],
  },
  {
    columnId: 'unansweredByAdmin',
    title: 'Yanıt',
    options: [
      { label: 'Yanıt bekliyor', value: 'true', icon: Reply },
      { label: 'Yanıtlandı', value: 'false', icon: CheckCircle2 },
    ],
  },
];

export function SupportTable({ replacements }: { replacements: ReplacementRow[] }) {
  const [scope, setScope] = React.useState<Scope>('queue');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const rows = React.useMemo(() => replacements ?? [], [replacements]);

  const counts = React.useMemo(
    () => ({
      queue: rows.filter((r) => inScope(r, 'queue')).length,
      unanswered: rows.filter((r) => inScope(r, 'unanswered')).length,
      all: rows.length,
    }),
    [rows],
  );

  // Kapsam süzgeci + öncelik sıralaması. DataTable'a `initialSorting` VERİLMEZ →
  // TanStack veri sırasını korur, yani buradaki öncelik sırası tabloda birebir görünür.
  const scoped = React.useMemo(
    () => rows.filter((r) => inScope(r, scope)).sort(byPriority),
    [rows, scope],
  );

  const columns = React.useMemo(() => buildColumns(setSelectedId), []);

  // Site facet'i VERİDEN türetilir (sabit liste değil): yalnız gerçekten talep gelmiş mağazalar
  // listelenir. TEK mağaza varsa facet GÖSTERİLMEZ — tek seçenekli süzgeç gürültüdür
  // (orders-table.tsx ile aynı desen).
  const facets = React.useMemo<FacetConfig[]>(() => {
    const domains = Array.from(
      new Set(rows.map((r) => r.siteDomain).filter((d): d is string => !!d)),
    ).sort((a, b) => a.localeCompare(b, 'tr'));
    return domains.length > 1
      ? [
          ...baseFacets,
          {
            columnId: 'siteDomain',
            title: 'Site',
            options: domains.map((d) => ({ label: d, value: d, icon: Globe })),
          },
        ]
      : baseFacets;
  }, [rows]);

  // Detay panelinin verisi HER ZAMAN taze listeden okunur: bir aksiyon sonrası
  // revalidate ile durum değişince panel de güncel durumu gösterir (bayat kopya yok).
  // Kapsam dışına düşse bile (ör. onaylanınca kuyruktan çıkar) panel açık kalır.
  const selected = selectedId ? (rows.find((r) => r.id === selectedId) ?? null) : null;

  React.useEffect(() => {
    // Talep listeden tamamen kaybolduysa (yeni veri) paneli kapat — boş panel kalmasın.
    if (selectedId && !rows.some((r) => r.id === selectedId)) setSelectedId(null);
  }, [rows, selectedId]);

  // Boş durum metni: kapsam gerçekten boş mu, yoksa arama/facet mi süzdü (dürüst mesaj).
  const emptyLabel =
    scoped.length > 0
      ? 'Bu filtrelerle eşleşen talep yok.'
      : scope === 'unanswered'
        ? 'Yanıt bekleyen talep yok.'
        : scope === 'queue'
          ? 'Açık destek talebi yok.'
          : 'Henüz destek talebi yok.';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div
          className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5"
          role="group"
          aria-label="Kuyruk kapsamı"
        >
          {SCOPES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setScope(s.key)}
              aria-pressed={scope === s.key}
              title={s.hint}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                scope === s.key
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {s.label}{' '}
              <span className="tabular-nums opacity-80">({counts[s.key]})</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Sıralama: yanıt bekleyenler en üstte, sonra açık ve bilgi bekleyen talepler.
        </p>
      </div>

      <DataTable
        columns={columns}
        data={scoped}
        searchColumnId="remoteOrderId"
        searchPlaceholder="Müşteri, sipariş no, mağaza, ürün veya talep metni…"
        facets={facets}
        emptyLabel={emptyLabel}
      />

      <SupportDetailSheet
        row={selected}
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      />
    </div>
  );
}
