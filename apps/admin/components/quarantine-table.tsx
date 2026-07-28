'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  Ban,
  Check,
  Copy,
  Download,
  ExternalLink,
  PackageX,
  ShieldAlert,
  Truck,
  type LucideIcon,
} from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import type { QuarantineItem } from '../app/quarantine/queries';
import { fmtDateTime } from '../lib/utils';
import { licenseItemStatusLabel, productKindLabel } from '../lib/labels';
import { downloadCsv, stamp, toCsv, type CsvColumn } from '../lib/csv';
import { Badge, type BadgeProps } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Alert, AlertDescription } from './ui/alert';
import { Combobox, type ComboboxItem } from './ui/combobox';
import { Field } from './ui/field';
import { Input, selectClass } from './ui/input';
import { SearchInput } from './ui/search-input';
import { StatStrip } from './ui/stat-tile';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';

// ── Yardımcılar (hepsi null-güvenli: alanlar backend sapmasında eksik gelebilir) ──

/** Türkçe küçültme (İ/ı) — arama karşılaştırması için. */
const lower = (s: string) => s.toLocaleLowerCase('tr-TR');

const ts = (iso?: string | null): number => {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** Ekranda: geçersiz/boş tarih → '—'. */
const showDate = (iso?: string | null): string => (ts(iso) ? fmtDateTime(iso as string) : '—');
/** CSV'de: geçersiz/boş tarih → boş hücre (Excel'de "—" metni istemiyoruz). */
const csvDate = (iso?: string | null): string => (ts(iso) ? fmtDateTime(iso as string) : '');

const statusText = (s?: string | null): string => (s ? licenseItemStatusLabel(s) : '—');

/** Süzgeç seçeneklerinde tedarikçisi olmayan kalemler için sanal değer. */
const NO_SUPPLIER = '__none__';

type StatusTone = { variant: NonNullable<BadgeProps['variant']>; Icon: LucideIcon };

const STATUS_TONE: Record<string, StatusTone> = {
  quarantined: { variant: 'danger', Icon: ShieldAlert },
  voided: { variant: 'warning', Icon: Ban },
};

const FALLBACK_TONE: StatusTone = { variant: 'neutral', Icon: ShieldAlert };

function QuarantineStatus({ status }: { status?: string | null }) {
  const meta: StatusTone = (status ? STATUS_TONE[status] : undefined) ?? FALLBACK_TONE;
  const Icon = meta.Icon;
  return (
    <Badge variant={meta.variant}>
      <Icon />
      {statusText(status)}
    </Badge>
  );
}

/** Uzun anahtar/hesap değeri: tek satır + tam değer `title`'da + kopyala. */
function KeyCell({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* pano erişimi yoksa sessiz geç — değer zaten ekranda seçilebilir */
    }
  }

  if (!value || value === '—') return <span className="text-muted-foreground">—</span>;

  return (
    <div className="flex items-center gap-1">
      <span className="block max-w-[15rem] truncate font-mono text-xs text-foreground" title={value}>
        {value}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7 shrink-0"
        onClick={copy}
        aria-label={copied ? 'Kopyalandı' : 'Lisans değerini kopyala'}
        title={copied ? 'Kopyalandı' : 'Kopyala'}
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </Button>
    </div>
  );
}

// ── Kolonlar ────────────────────────────────────────────────────────────────
const columns: ColumnDef<QuarantineItem>[] = [
  {
    id: 'productName',
    accessorFn: (r) => r.productName ?? '',
    meta: { title: 'Ürün' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Ürün" />,
    cell: ({ row }) => {
      const { productName, productKind, sku } = row.original;
      return (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium" title={productName ?? undefined}>
            {productName ?? '—'}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {productKind ? productKindLabel(productKind) : '—'}
            {sku ? ` · ${sku}` : ''}
          </span>
        </div>
      );
    },
  },
  {
    id: 'status',
    accessorFn: (r) => r.status ?? '',
    meta: { title: 'Durum' },
    header: 'Durum',
    enableSorting: false,
    cell: ({ row }) => <QuarantineStatus status={row.original.status} />,
  },
  {
    id: 'keyPreview',
    accessorFn: (r) => r.keyPreview ?? '',
    meta: { title: 'Lisans / hesap değeri' },
    header: 'Lisans / hesap değeri',
    enableSorting: false,
    cell: ({ row }) => <KeyCell value={row.original.keyPreview ?? ''} />,
  },
  {
    id: 'reason',
    accessorFn: (r) => r.reason ?? '',
    meta: { title: 'Sebep' },
    header: 'Sebep',
    enableSorting: false,
    cell: ({ row }) => (
      <span
        className="block max-w-[14rem] truncate text-muted-foreground"
        title={row.original.reason ?? undefined}
      >
        {row.original.reason ?? '—'}
      </span>
    ),
  },
  {
    id: 'supplierName',
    accessorFn: (r) => r.supplierName ?? '',
    meta: { title: 'Tedarikçi / parti' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Tedarikçi / parti" />,
    cell: ({ row }) => {
      const { supplierId, supplierName, batchCode } = row.original;
      if (!supplierName && !batchCode) return <span className="text-muted-foreground">—</span>;
      return (
        <div className="flex min-w-0 flex-col">
          {supplierId && supplierName ? (
            // Tedarikçi karnesine kısa yol: "bu partiden şu anahtarlar bozuk" konuşmasını
            // başlatacak kişi/kayıt tek tıkla açılır.
            <Link
              href={`/suppliers/${supplierId}`}
              className="truncate text-foreground underline-offset-4 hover:underline"
              title={supplierName}
            >
              {supplierName}
            </Link>
          ) : (
            <span className="truncate" title={supplierName ?? undefined}>
              {supplierName ?? 'Tedarikçi bilinmiyor'}
            </span>
          )}
          {batchCode && (
            <span className="truncate text-xs text-muted-foreground" title={batchCode}>
              Parti: {batchCode}
            </span>
          )}
        </div>
      );
    },
  },
  {
    id: 'order',
    accessorFn: (r) => r.remoteOrderId ?? r.sourceRemoteOrderId ?? '',
    meta: { title: 'Kaynak sipariş' },
    header: 'Kaynak sipariş',
    enableSorting: false,
    cell: ({ row }) => {
      const orderId = row.original.orderId ?? row.original.sourceOrderId ?? null;
      const remote = row.original.remoteOrderId ?? row.original.sourceRemoteOrderId ?? null;
      const { siteDomain, storeAdminUrl } = row.original;
      if (!orderId && !remote) return <span className="text-muted-foreground">—</span>;
      return (
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1">
            {orderId ? (
              <Link
                href={`/orders/${orderId}`}
                className="font-medium tabular-nums text-foreground underline-offset-4 hover:underline"
                aria-label={`Panel siparişi ${remote ?? ''} detayına git`}
              >
                {remote ?? 'Siparişi aç'}
              </Link>
            ) : (
              <span className="tabular-nums text-foreground">{remote}</span>
            )}
            {storeAdminUrl && (
              <a
                href={storeAdminUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                title="Mağaza panelinde aç"
                aria-label="Siparişi mağaza panelinde aç (yeni sekme)"
              >
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            )}
          </span>
          {siteDomain && (
            <span className="truncate text-xs text-muted-foreground" title={siteDomain}>
              {siteDomain}
            </span>
          )}
        </div>
      );
    },
  },
  {
    id: 'customerEmail',
    accessorFn: (r) => r.customerEmail ?? '',
    meta: { title: 'Müşteri' },
    header: 'Müşteri',
    enableSorting: false,
    cell: ({ row }) => (
      <span
        className="block max-w-[13rem] truncate text-muted-foreground"
        title={row.original.customerEmail ?? undefined}
      >
        {row.original.customerEmail ?? '—'}
      </span>
    ),
  },
  {
    id: 'quarantinedAt',
    accessorFn: (r) => r.quarantinedAt ?? '',
    meta: { title: 'Karantina tarihi' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Karantina tarihi" />,
    // Kendi sıralayıcımız: `datetime` sortingFn null/boş tarihte patlar (bu alan null olabilir).
    sortingFn: (a, b) => ts(a.original.quarantinedAt) - ts(b.original.quarantinedAt),
    cell: ({ row }) => (
      <span className="whitespace-nowrap tabular-nums text-muted-foreground">
        {showDate(row.original.quarantinedAt)}
      </span>
    ),
  },
];

// ── CSV: İKİ AYRI İÇERİK ────────────────────────────────────────────────────
// Bu ekranın ana işi "çalışmayan anahtarların listesini TEDARİKÇİYE ilet". O dosyada müşteri
// e-postası ve mağaza sipariş numarası İŞİ GÖRMEZ ama 3. tarafa kişisel veri taşır (KVKK) —
// üstelik TAM düz lisans anahtarıyla AYNI satırda birleşir. Bu yüzden dışa aktarma ikiye ayrıldı:
// tedarikçi bildirimi (kişisel veri YOK) ve iç denetim (tam set, panel dışına çıkmamalı).

/** Tedarikçi bildirimi — kusurlu kalemi tanımlayan teknik/tedarik kolonları. Kişisel veri YOK. */
const supplierCsvColumns: CsvColumn<QuarantineItem>[] = [
  { header: 'Ürün', value: (r) => r.productName ?? '' },
  { header: 'SKU', value: (r) => r.sku ?? '' },
  { header: 'Tür', value: (r) => (r.productKind ? productKindLabel(r.productKind) : '') },
  { header: 'Lisans/Hesap değeri', value: (r) => r.keyPreview ?? '' },
  { header: 'Durum', value: (r) => (r.status ? licenseItemStatusLabel(r.status) : '') },
  { header: 'Sebep', value: (r) => r.reason ?? '' },
  { header: 'Parti kodu', value: (r) => r.batchCode ?? '' },
  { header: 'Tedarikçi', value: (r) => r.supplierName ?? '' },
  { header: 'Stok giriş tarihi', value: (r) => csvDate(r.createdAt) },
  { header: 'Karantina tarihi', value: (r) => csvDate(r.quarantinedAt) },
];

/** İç denetim — tedarikçi seti + izleme kolonları. KİŞİSEL VERİ İÇERİR (müşteri e-postası). */
const auditCsvColumns: CsvColumn<QuarantineItem>[] = [
  ...supplierCsvColumns,
  { header: 'Mağaza sipariş no', value: (r) => r.remoteOrderId ?? r.sourceRemoteOrderId ?? '' },
  { header: 'Site', value: (r) => r.siteDomain ?? '' },
  { header: 'Müşteri e-postası', value: (r) => r.customerEmail ?? '' },
];

/** Dışa aktarma içeriği: tedarikçiye gidecek sürüm mü, iç denetim (tam) sürüm mü. */
type CsvVariant = 'supplier' | 'audit';

const CSV_VARIANT: Record<CsvVariant, { columns: CsvColumn<QuarantineItem>[]; file: string }> = {
  supplier: { columns: supplierCsvColumns, file: 'karantina-tedarikci' },
  audit: { columns: auditCsvColumns, file: 'karantina-ic-denetim' },
};

// ── Ekran ───────────────────────────────────────────────────────────────────
export function QuarantineTable({
  rows,
  truncated = false,
}: {
  rows: QuarantineItem[];
  truncated?: boolean;
}) {
  const all = React.useMemo(() => rows ?? [], [rows]);

  const [q, setQ] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [productId, setProductId] = React.useState('');
  const [supplierId, setSupplierId] = React.useState('');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');

  // Süzgeç seçenekleri LİSTEDEN türetilir → yalnız karantinada gerçekten kalemi olan
  // ürün/tedarikçi görünür (boş seçim yok, ekstra API çağrısı yok).
  const productItems = React.useMemo<ComboboxItem[]>(() => {
    const map = new Map<string, ComboboxItem>();
    for (const r of all) {
      const id = r.productId ?? r.productName;
      if (!id) continue;
      if (!map.has(id)) {
        map.set(id, {
          value: id,
          label: r.productName ?? 'Adsız ürün',
          hint: r.sku ?? undefined,
          keywords: [r.sku ?? ''],
        });
      }
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'tr-TR'));
  }, [all]);

  const supplierItems = React.useMemo<ComboboxItem[]>(() => {
    const map = new Map<string, ComboboxItem>();
    let hasUnknown = false;
    for (const r of all) {
      const id = r.supplierId ?? (r.supplierName ? `name:${r.supplierName}` : null);
      if (!id) {
        hasUnknown = true;
        continue;
      }
      if (!map.has(id)) map.set(id, { value: id, label: r.supplierName ?? 'Adsız tedarikçi' });
    }
    const list = [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'tr-TR'));
    if (hasUnknown) list.push({ value: NO_SUPPLIER, label: 'Tedarikçisi bilinmiyor' });
    return list;
  }, [all]);

  const filtered = React.useMemo(() => {
    const needle = lower(q.trim());
    // Gün sınırları SABİT +03:00 (Europe/Istanbul, DST yok) — tarihler ekranda da bu saat
    // diliminde gösteriliyor; operatörün makinesi başka bir zaman diliminde olsa bile
    // "28 Temmuz" satırı "28 Temmuz" aralığında kalır.
    const fromTs = from ? Date.parse(`${from}T00:00:00+03:00`) : Number.NaN;
    const toTs = to ? Date.parse(`${to}T23:59:59.999+03:00`) : Number.NaN;

    return all.filter((r) => {
      if (status && r.status !== status) return false;

      if (productId) {
        const pid = r.productId ?? r.productName ?? '';
        if (pid !== productId) return false;
      }

      if (supplierId) {
        const sid = r.supplierId ?? (r.supplierName ? `name:${r.supplierName}` : null);
        if (supplierId === NO_SUPPLIER ? sid !== null : sid !== supplierId) return false;
      }

      if (!Number.isNaN(fromTs) || !Number.isNaN(toTs)) {
        const t = ts(r.quarantinedAt);
        if (!t) return false;
        if (!Number.isNaN(fromTs) && t < fromTs) return false;
        if (!Number.isNaN(toTs) && t > toTs) return false;
      }

      if (needle) {
        const hay = lower(
          [
            r.productName,
            r.sku,
            r.keyPreview,
            r.customerEmail,
            r.remoteOrderId ?? r.sourceRemoteOrderId,
            r.batchCode,
            r.supplierName,
            r.siteDomain,
            r.reason,
          ]
            .filter(Boolean)
            .join(' '),
        );
        if (!hay.includes(needle)) return false;
      }

      return true;
    });
  }, [all, q, status, productId, supplierId, from, to]);

  const hasFilters = Boolean(q || status || productId || supplierId || from || to);

  const counts = React.useMemo(() => {
    let quarantined = 0;
    let voided = 0;
    let traceable = 0;
    for (const r of all) {
      if (r.status === 'quarantined') quarantined += 1;
      else if (r.status === 'voided') voided += 1;
      if (r.supplierId || r.supplierName) traceable += 1;
    }
    return { quarantined, voided, traceable };
  }, [all]);

  function exportCsv(scope: 'visible' | 'all', variant: CsvVariant) {
    const data = scope === 'visible' ? filtered : all;
    if (!data.length) return;
    const { columns: cols, file } = CSV_VARIANT[variant];
    // Dosya adı içeriği de söyler: yanlışlıkla "iç denetim" dosyasını tedarikçiye göndermek zorlaşır.
    downloadCsv(`${file}_${stamp()}.csv`, toCsv(data, cols));
  }

  function reset() {
    setQ('');
    setStatus('');
    setProductId('');
    setSupplierId('');
    setFrom('');
    setTo('');
  }

  return (
    <div className="space-y-4">
      <StatStrip
        items={[
          { icon: PackageX, label: 'Toplam kalem', value: all.length },
          {
            icon: ShieldAlert,
            label: statusText('quarantined'),
            value: counts.quarantined,
            tone: 'danger',
          },
          { icon: Ban, label: statusText('voided'), value: counts.voided, tone: 'warning' },
          {
            icon: Truck,
            label: 'Tedarikçisi belli',
            value: counts.traceable,
            hint: 'değişim talep edilebilir',
          },
        ]}
      />

      {truncated && (
        <Alert variant="warning">
          <ShieldAlert aria-hidden />
          <AlertDescription>
            Liste üst sınıra ulaştı; daha eski kalemler gösterilmiyor olabilir. Dışa aktarmadan önce
            tarih aralığı veya tedarikçi süzgeciyle daraltın.
          </AlertDescription>
        </Alert>
      )}

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label="Ara"
            htmlFor="karantina-ara"
            className="lg:col-span-2"
            hint="Ürün, SKU, lisans değeri, müşteri, sipariş no, parti veya tedarikçi."
          >
            <SearchInput
              id="karantina-ara"
              value={q}
              onValueChange={setQ}
              placeholder="Karantinadaki kalemlerde ara…"
              ariaLabel="Karantinadaki kalemlerde ara"
              className="w-full"
              inputClassName="h-9"
            />
          </Field>

          <Field label="Durum" htmlFor="karantina-durum">
            <select
              id="karantina-durum"
              className={selectClass}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">Tümü</option>
              <option value="quarantined">{statusText('quarantined')}</option>
              <option value="voided">{statusText('voided')}</option>
            </select>
          </Field>

          <Field label="Ürün" htmlFor="karantina-urun">
            <Combobox
              id="karantina-urun"
              ariaLabel="Ürüne göre süz"
              items={productItems}
              value={productId}
              onValueChange={setProductId}
              placeholder="Tüm ürünler"
              searchPlaceholder="Ürün ara…"
              emptyText="Ürün bulunamadı"
              allowClear
              clearLabel="— tüm ürünler —"
            />
          </Field>

          <Field label="Tedarikçi" htmlFor="karantina-tedarikci">
            <Combobox
              id="karantina-tedarikci"
              ariaLabel="Tedarikçiye göre süz"
              items={supplierItems}
              value={supplierId}
              onValueChange={setSupplierId}
              placeholder="Tüm tedarikçiler"
              searchPlaceholder="Tedarikçi ara…"
              emptyText="Tedarikçi bulunamadı"
              allowClear
              clearLabel="— tüm tedarikçiler —"
            />
          </Field>

          <Field label="Karantina tarihi (aralık)" htmlFor="karantina-baslangic">
            <div className="flex items-center gap-2">
              <Input
                id="karantina-baslangic"
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
                aria-label="Başlangıç tarihi"
              />
              <span className="text-xs text-muted-foreground" aria-hidden>
                –
              </span>
              <Input
                id="karantina-bitis"
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                aria-label="Bitiş tarihi"
              />
            </div>
          </Field>
        </div>

        <div className="mt-4 flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium tabular-nums text-foreground">{filtered.length}</span> kalem
            listeleniyor{filtered.length !== all.length ? ` (toplam ${all.length})` : ''}
            {hasFilters && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={reset}
                  className="rounded-sm text-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  Süzgeçleri temizle
                </button>
              </>
            )}
          </p>

          <div className="flex items-center gap-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={all.length === 0}>
                  <Download aria-hidden />
                  Dışa Aktar (CSV)
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[21rem]">
                <DropdownMenuLabel>Tedarikçi bildirimi</DropdownMenuLabel>
                <p className="px-2.5 pb-1.5 text-xs leading-snug text-muted-foreground">
                  Ürün, SKU, tür, lisans değeri, durum, sebep, parti, tedarikçi ve tarihler.
                  Müşteri e-postası ve sipariş no <strong className="font-medium">yok</strong>.
                </p>
                <DropdownMenuItem
                  onSelect={() => exportCsv('visible', 'supplier')}
                  disabled={filtered.length === 0}
                >
                  <Download aria-hidden />
                  Görünen satırlar ({filtered.length})
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => exportCsv('all', 'supplier')}
                  disabled={all.length === 0}
                >
                  <Download aria-hidden />
                  Tümü ({all.length})
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuLabel>İç denetim (tüm kolonlar)</DropdownMenuLabel>
                <p className="flex gap-1.5 px-2.5 pb-1.5 text-xs leading-snug text-warning">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    Yukarıdakilere ek olarak site, sipariş no ve{' '}
                    <strong className="font-medium">müşteri e-postası</strong> içerir — kişisel
                    veridir, tedarikçiye/3. tarafa göndermeyin.
                  </span>
                </p>
                <DropdownMenuItem
                  onSelect={() => exportCsv('visible', 'audit')}
                  disabled={filtered.length === 0}
                >
                  <Download aria-hidden />
                  Görünen satırlar ({filtered.length})
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => exportCsv('all', 'audit')}
                  disabled={all.length === 0}
                >
                  <Download aria-hidden />
                  Tümü ({all.length})
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground sm:text-right">
          Excel ile açılır (.csv). Tedarikçiye gönderilecek dosyayı{' '}
          <span className="text-foreground">Tedarikçi bildirimi</span> seçeneğinden indirin —
          müşteri bilgisi içermez.
        </p>
      </Card>

      <DataTable
        columns={columns}
        data={filtered}
        initialSorting={[{ id: 'quarantinedAt', desc: true }]}
        pageSize={50}
        emptyLabel={
          all.length === 0
            ? 'Karantinada kalem yok — arızalı bildirilen lisanslar burada listelenir.'
            : 'Süzgeçlere uyan kalem yok.'
        }
      />
    </div>
  );
}
