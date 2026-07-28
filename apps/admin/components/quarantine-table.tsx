'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Ban,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  PackageX,
  RefreshCw,
  ShieldAlert,
  Truck,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { Column, ColumnDef } from '@tanstack/react-table';
import type {
  QuarantineFilterState,
  QuarantineItem,
  QuarantineRange,
  QuarantineStatusFilter,
} from '../app/quarantine/queries';
import { cn, fmtDateTime } from '../lib/utils';
import { licenseItemStatusLabel, productKindLabel } from '../lib/labels';
import {
  downloadCsv,
  downloadText,
  stamp,
  toCsv,
  toTextList,
  type CsvColumn,
} from '../lib/csv';
import { Badge, type BadgeProps } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Alert, AlertDescription } from './ui/alert';
import { Field } from './ui/field';
import { Input, checkboxClass } from './ui/input';
import { SearchInput } from './ui/search-input';
import { StatStrip } from './ui/stat-tile';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import {
  DataTableFacetedFilter,
  type FacetOption,
} from './data-table/data-table-faceted-filter';

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

/** Tedarikçisi olmayan kalemler için sanal süzgeç değeri (aşağıdaki nota bakın). */
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

// ── Süzgeç modeli (İKİ KATMAN) ──────────────────────────────────────────────
// 1) SUNUCU süzgeci — durum · tarih aralığı · arama. URL'de taşınır, sayfa sunucuda yeniden
//    render edilir; sorgu veritabanındaki TÜM kayıtları tarar (yalnız yüklenen pencereyi değil),
//    sonuç en fazla `limit` kayıttır → kırpılırsa uyarı. Bkz. `QuarantineServerFilters`.
// 2) YEREL (hızlı) süzgeç — aşağıdaki facet'ler + anlık arama; yalnız YÜKLENEN pencere içinde.
//
// Yerel süzme TABLONUN İÇİNDE değil BURADA yapılır (bkz. queries.ts notu): dışa aktarmanın
// "görünen N kayıt" sayısı ancak süzülmüş küme tek yerde tutulursa dürüst olur.
//
// DURUM neden yerel facet DEĞİL: sunucu süzgecinde (tek doğruluk kaynağı). İkisi birden olsaydı
// "durumu seçtim ama liste değişmedi/çakıştı" karmaşası doğardı.

type FacetKey = 'product' | 'supplier' | 'site';

const FACET_KEYS: FacetKey[] = ['product', 'supplier', 'site'];

const FACET_TITLE: Record<FacetKey, string> = {
  product: 'Ürün',
  supplier: 'Tedarikçi',
  site: 'Site',
};

/**
 * Satırdan süzgeç değeri — seçenek listesi, sayaçlar ve süzme AYNI fonksiyondan okur
 * (tek kaynak; ayrışırlarsa "seçtim ama liste boşaldı" hatası doğar).
 *
 * `null` → o satır bu süzgeç için değersiz; seçenek ÜRETİLMEZ (boş "—" seçeneği yok).
 * TEK İSTİSNA tedarikçi: karantina ekranının işi "tedarikçiden değişim iste" olduğu için
 * "tedarikçisi bilinmeyen" kalemleri ayırabilmek operasyonel olarak anlamlıdır → bunlar
 * boş bırakılmaz, adlandırılmış bir kovaya (NO_SUPPLIER) düşer.
 */
const FACET_VALUE: Record<FacetKey, (r: QuarantineItem) => string | null> = {
  product: (r) => r.productId ?? r.productName ?? null,
  supplier: (r) => r.supplierId ?? (r.supplierName ? `name:${r.supplierName}` : NO_SUPPLIER),
  site: (r) => r.siteDomain ?? null,
};

/** Süzgeç değerinin ekranda görünecek Türkçe karşılığı (ham enum/UUID ASLA çıkmaz). */
const FACET_LABEL: Record<FacetKey, (r: QuarantineItem) => string> = {
  product: (r) => r.productName ?? 'Adsız ürün',
  // Üç ayrı durum: adı bilinen tedarikçi · kaydı olan ama adsız · hiç tedarikçisi olmayan.
  supplier: (r) => r.supplierName ?? (r.supplierId ? 'Adsız tedarikçi' : 'Tedarikçisi bilinmiyor'),
  site: (r) => r.siteDomain ?? '',
};

// ── SUNUCU süzgeci (URL parametresi) ────────────────────────────────────────
// Bu üç süzgeç API'ye gider (`?status=&from=&to=&q=`) ve VERİTABANI sorgusunda uygulanır.
// Denetim bulgusu: eskiden durum/tarih yalnız istemcideydi → "son 90 gün + tedarikçi X" seçimi
// yalnız EN YENİ 5000 kaydın içinde arıyordu; 12.000 kayıtlı kurulumda eski kalemler "yok"
// görünüyordu ve kırpılma uyarısının önerdiği eylem uygulanamıyordu.
// G6 (bu dalganın kendi bulgusu): tarih süzgeci "sunucuda" ilan edilmiş ama SQL'e KONMAMIŞTI —
// sunucu en yeni pencereyi çekip tarihi bellekte süzüyordu → geçmiş bir dönem seçilince liste
// boş ve kırpılma uyarısı da yanlış (false) çıkıyordu. Artık tarih SQL'de ön-süzülür ve
// kırpılma sinyali ham sorgu satır sayısından gelir.

/** Durum süzgeci seçenekleri (Türkçe etiketler labels.ts tek kaynağından). */
const STATUS_FILTERS: { value: QuarantineStatusFilter; label: string }[] = [
  { value: '', label: 'Tümü' },
  { value: 'quarantined', label: statusText('quarantined') },
  { value: 'voided', label: statusText('voided') },
];

/** Tarih aralığı hızlı ön ayarları — takvim bileşeni yok, tek tık. */
const RANGE_PRESETS: { value: QuarantineRange; label: string }[] = [
  { value: '', label: 'Tümü' },
  { value: '7', label: 'Son 7 gün' },
  { value: '30', label: 'Son 30 gün' },
  { value: '90', label: 'Son 90 gün' },
  { value: 'custom', label: 'Özel aralık' },
];

/**
 * Date → YYYY-MM-DD (operatörün YEREL günü).
 *
 * Ön ayarlar tıklandığı ANDA sabit bir tarihe çevrilip URL'ye yazılır (kayan pencere değil):
 * böylece bağlantı paylaşılabilir/yer imlenebilir ve sunucu ile istemci aynı sınırı görür
 * (ilk render'da `Date.now()` OKUNMAZ → hydration uyuşmazlığı olmaz).
 */
function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** YYYY-MM-DD → 28.07.2026 (ekran metni). */
const trDay = (iso: string): string => iso.split('-').reverse().join('.');

/** Aktif tarih aralığının insan-okur özeti (yoksa null). */
function rangeSummary(f: QuarantineFilterState): string | null {
  if (!f.from && !f.to) return null;
  const preset = RANGE_PRESETS.find((p) => p.value === f.range && p.value && p.value !== 'custom');
  if (preset) return preset.label;
  return `${f.from ? trDay(f.from) : '…'} – ${f.to ? trDay(f.to) : '…'}`;
}

/**
 * Sunucu süzgeci çubuğu. Her değişiklik URL'yi günceller (`router.push`) → sayfa sunucuda
 * yeniden çekilir. `useTransition` ile bekleme görünür olur (operatör "tıkladım, bir şey
 * olmadı" sanmasın); geçiş sırasında kontroller kilitlenir.
 */
function QuarantineServerFilters({
  filters,
  limit,
}: {
  filters: QuarantineFilterState;
  /** Sunucunun döndürebileceği en fazla kayıt — "tüm kayıtlarda arar AMA N kayıt döner" dürüstlüğü. */
  limit?: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  // Taslak (henüz uygulanmamış) alanlar. Sunucudan gelen değer değişince senkronlanır —
  // tarayıcı geri/ileri tuşu da doğru çalışsın.
  const [range, setRange] = React.useState<QuarantineRange>(filters.range);
  const [from, setFrom] = React.useState(filters.from);
  const [to, setTo] = React.useState(filters.to);
  const [search, setSearch] = React.useState(filters.search);

  React.useEffect(() => {
    setRange(filters.range);
    setFrom(filters.from);
    setTo(filters.to);
    setSearch(filters.search);
  }, [filters.range, filters.from, filters.to, filters.search]);

  const go = React.useCallback(
    (next: Partial<QuarantineFilterState>) => {
      // Kutuda YAZILI olan arama metni her gezinmede taşınır: operatör "abc" yazıp Enter'a
      // basmadan durum düğmesine tıklarsa yazdığı metin sessizce KAYBOLMAZ (kutuda görünen =
      // uygulanan). Seçili aralık düğmesi de taşınır ("Özel aralık" açıkken durum değiştirince
      // tarih kutuları kapanmasın). Tarih DEĞERLERİ bilinçli taslak kalır — "Uygula" ile gider.
      const merged = { ...filters, search: search.trim(), range, ...next };
      const params = new URLSearchParams();
      if (merged.status) params.set('status', merged.status);
      if (merged.range) params.set('range', merged.range);
      if (merged.from) params.set('from', merged.from);
      if (merged.to) params.set('to', merged.to);
      if (merged.search) params.set('q', merged.search);
      const qs = params.toString();
      startTransition(() => router.push(qs ? `/quarantine?${qs}` : '/quarantine'));
    },
    [filters, router, search, range],
  );

  function pickRange(value: QuarantineRange) {
    setRange(value);
    // Özel aralık: tarihler girilip "Uygula"ya basılınca gider (her tıkta istek atma).
    if (value === 'custom') return;
    if (value === '') return go({ range: '', from: '', to: '' });
    go({ range: value, from: isoDay(new Date(Date.now() - Number(value) * 86_400_000)), to: '' });
  }

  const active = Boolean(filters.status || filters.from || filters.to || filters.search);
  const rangeLabel = rangeSummary(filters);
  const summary = [
    filters.status ? `Durum: ${statusText(filters.status)}` : null,
    rangeLabel ? `Tarih: ${rangeLabel}` : null,
    filters.search ? `Arama: “${filters.search}”` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Card className="p-4" aria-busy={pending}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Sunucu süzgeci</h3>
          <p className="text-xs text-muted-foreground">
            Veritabanındaki TÜM kayıtlarda süzer ve listeyi yeniden yükler; tek seferde en fazla{' '}
            {(limit ?? 5000).toLocaleString('tr-TR')} kayıt gelir (sığmazsa uyarı çıkar). Aşağıdaki
            hızlı süzgeçler ise yalnız yüklenen liste içinde çalışır.
          </p>
          {pending && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <RefreshCw className="size-3 animate-spin" aria-hidden />
              Yükleniyor…
            </span>
          )}
        </div>

        {summary && (
          <p className="text-xs text-foreground/80">
            <span className="text-muted-foreground">Uygulanan sunucu süzgeci:</span> {summary}
          </p>
        )}

        {/* Durum */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-foreground/70" id="karantina-durum-etiket">
            Durum
          </span>
          <div className="flex flex-wrap gap-1" role="group" aria-labelledby="karantina-durum-etiket">
            {STATUS_FILTERS.map((s) => (
              <Button
                key={s.value || 'all'}
                type="button"
                size="sm"
                variant={filters.status === s.value ? 'default' : 'outline'}
                aria-pressed={filters.status === s.value}
                disabled={pending}
                onClick={() => go({ status: s.value })}
              >
                {s.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Karantina tarihi */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-foreground/70" id="karantina-tarih-etiket">
            Karantina tarihi
          </span>
          <div className="flex flex-wrap gap-1" role="group" aria-labelledby="karantina-tarih-etiket">
            {RANGE_PRESETS.map((p) => (
              <Button
                key={p.value || 'all'}
                type="button"
                size="sm"
                variant={range === p.value ? 'default' : 'outline'}
                aria-pressed={range === p.value}
                disabled={pending}
                onClick={() => pickRange(p.value)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          {range === 'custom' && (
            <div className="flex items-center gap-2">
              <Input
                id="karantina-baslangic"
                type="date"
                className="h-8 w-auto"
                value={from}
                max={to || undefined}
                disabled={pending}
                onChange={(e) => setFrom(e.target.value)}
                aria-label="Başlangıç tarihi"
              />
              <span className="text-xs text-muted-foreground" aria-hidden>
                –
              </span>
              <Input
                id="karantina-bitis"
                type="date"
                className="h-8 w-auto"
                value={to}
                min={from || undefined}
                disabled={pending}
                onChange={(e) => setTo(e.target.value)}
                aria-label="Bitiş tarihi"
              />
              <Button
                type="button"
                size="sm"
                disabled={pending}
                onClick={() =>
                  from || to
                    ? go({ range: 'custom', from, to })
                    : go({ range: '', from: '', to: '' })
                }
              >
                Uygula
              </Button>
            </div>
          )}
        </div>

        {/* Sunucu araması */}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            go({ search: search.trim() });
          }}
        >
          <Field
            label="Tüm kayıtlarda ara"
            htmlFor="karantina-sunucu-ara"
            className="min-w-0 flex-1 sm:max-w-md"
            hint="Ürün adı/SKU, müşteri e-postası, sipariş no, parti etiketi veya tedarikçi adı. Anahtar içeriği aranmaz (şifreli)."
          >
            <SearchInput
              id="karantina-sunucu-ara"
              value={search}
              onValueChange={setSearch}
              placeholder="Sunucuda ara ve listeyi yeniden yükle…"
              ariaLabel="Tüm karantina kayıtlarında ara (sunucu)"
              className="w-full"
              inputClassName="h-9"
            />
          </Field>
          <Button type="submit" size="sm" variant="outline" disabled={pending} className="h-9">
            Ara
          </Button>
          {active && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              className="h-9"
              onClick={() => startTransition(() => router.push('/quarantine'))}
            >
              <X aria-hidden />
              Sunucu süzgecini temizle
            </Button>
          )}
        </form>
      </div>
    </Card>
  );
}

// ── Dışa aktarma: İKİ AYRI İÇERİK ───────────────────────────────────────────
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

/**
 * Düz metin satırı — tedarikçiye mesajda YAPIŞTIRMAK için: ürün + anahtar + sebep.
 * Sütun/ayraç yok, tek okunabilir satır.
 */
const supplierTextLine = (r: QuarantineItem, i: number): string =>
  [
    `${i + 1}. ${r.productName ?? 'Ürün bilinmiyor'}${r.sku ? ` (${r.sku})` : ''}`,
    r.keyPreview ?? '—',
    `Sebep: ${r.reason ?? 'belirtilmemiş'}`,
  ].join(' — ');

/** İç denetim metni: aynı satır + izleme bilgisi (site · sipariş · müşteri). */
const auditTextLine = (r: QuarantineItem, i: number): string => {
  const trace = [
    r.siteDomain,
    r.remoteOrderId ?? r.sourceRemoteOrderId ? `Sipariş ${r.remoteOrderId ?? r.sourceRemoteOrderId}` : null,
    r.customerEmail,
  ]
    .filter(Boolean)
    .join(' · ');
  return trace ? `${supplierTextLine(r, i)} — ${trace}` : supplierTextLine(r, i);
};

type ExportVariant = 'supplier' | 'audit';
type ExportScope = 'visible' | 'all';
type ExportFormat = 'csv' | 'txt';

interface VariantSpec {
  title: string;
  file: string;
  columns: CsvColumn<QuarantineItem>[];
  line: (row: QuarantineItem, index: number) => string;
  /** Dosyaya (ve panele) yazılan kişisel veri uyarısı — yalnız iç denetim sürümünde. */
  warning?: string;
}

const EXPORT_VARIANT: Record<ExportVariant, VariantSpec> = {
  supplier: {
    title: 'Tedarikçi bildirimi',
    // Dosya adı içeriği de söyler: yanlışlıkla "iç denetim" dosyasını tedarikçiye göndermek zorlaşır.
    file: 'karantina-tedarikci',
    columns: supplierCsvColumns,
    line: supplierTextLine,
  },
  audit: {
    title: 'İç denetim',
    file: 'karantina-ic-denetim',
    columns: auditCsvColumns,
    line: auditTextLine,
    warning: 'UYARI: Bu dosya müşteri kişisel verisi içerir — tedarikçiye/3. tarafa göndermeyin.',
  },
};

/** Popover içindeki tek seçimli (radio) seçenek grubu — klavye ile gezilebilir. */
function ChoiceGroup<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
}: {
  legend: string;
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; hint?: string; disabled?: boolean }[];
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {legend}
      </legend>
      {options.map((o) => (
        <label
          key={o.value}
          className={cn(
            'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors',
            o.disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-accent',
            value === o.value && !o.disabled && 'bg-accent',
          )}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={o.disabled}
            onChange={() => onChange(o.value)}
            className={cn(checkboxClass, 'mt-0.5 rounded-full')}
          />
          <span className="min-w-0">
            <span className="block text-sm leading-tight text-foreground">{o.label}</span>
            {o.hint && (
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{o.hint}</span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Arama/süzme için satır başına ÖNCEDEN hesaplanmış indeks.
 *
 * Neden: eskiden her tuş vuruşunda satır başına 9 alan birleştirilip Türkçe küçültme yapılıyordu
 * ve bu iş hem süzme hem de her facet sayacı için TEKRARLANIYORDU (5×N) → 5000 kayıtta yazma
 * gözle görülür takılıyordu. Artık `hay` ve facet değerleri kaynak liste değiştiğinde BİR KEZ
 * üretilir; tuş başına yalnız `includes` çalışır.
 */
interface IndexedRow {
  row: QuarantineItem;
  /** Aranabilir alanların birleşimi (Türkçe küçültülmüş). */
  hay: string;
  keys: Record<FacetKey, string | null>;
}

// ── Ekran ───────────────────────────────────────────────────────────────────
export function QuarantineTable({
  rows,
  truncated = false,
  limit,
  filters,
}: {
  rows: QuarantineItem[];
  truncated?: boolean;
  /** Sunucunun okuduğu üst sınır (queries.QUARANTINE_LIMIT) — kırpılma uyarısında yazılır. */
  limit?: number;
  /** URL'den gelen SUNUCU süzgeçleri (durum/tarih/arama) — sayfa tarafından doğrulanır. */
  filters: QuarantineFilterState;
}) {
  const all = React.useMemo(() => rows ?? [], [rows]);

  const [q, setQ] = React.useState('');
  /** Debounce edilmiş arama terimi — süzme yalnız yazma durunca çalışsın. */
  const [term, setTerm] = React.useState('');
  const [facetValues, setFacetValues] = React.useState<Record<FacetKey, string[]>>({
    product: [],
    supplier: [],
    site: [],
  });

  const setFacet = React.useCallback((key: FacetKey, values: string[]) => {
    setFacetValues((prev) => ({ ...prev, [key]: values }));
  }, []);

  // Yazma sırasında 5000 satırlık süzme + 3 facet sayacı her tuşta koşmasın (F14).
  React.useEffect(() => {
    const t = window.setTimeout(() => setTerm(q.trim()), 180);
    return () => window.clearTimeout(t);
  }, [q]);

  const needle = React.useMemo(() => lower(term), [term]);

  const indexed = React.useMemo<IndexedRow[]>(
    () =>
      all.map((r) => ({
        row: r,
        hay: lower(
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
        ),
        keys: {
          product: FACET_VALUE.product(r),
          supplier: FACET_VALUE.supplier(r),
          site: FACET_VALUE.site(r),
        },
      })),
    [all],
  );

  /**
   * Bir satır YEREL süzgeçlere uyuyor mu. `skip` verilirse O SÜZGEÇ atlanır — facet sayaçları
   * "bu seçeneği eklersem kaç kayıt kalır"ı gösterebilsin (çapraz süzme).
   * (Durum/tarih süzgeci burada YOK: onlar sunucuda uygulanır.)
   */
  const match = React.useCallback(
    (item: IndexedRow, skip?: FacetKey): boolean => {
      for (const key of FACET_KEYS) {
        if (key === skip) continue;
        const selected = facetValues[key];
        if (!selected.length) continue;
        const value = item.keys[key];
        if (value === null || !selected.includes(value)) return false;
      }
      if (needle && !item.hay.includes(needle)) return false;
      return true;
    },
    [facetValues, needle],
  );

  const filtered = React.useMemo(
    () => indexed.filter((item) => match(item)).map((item) => item.row),
    [indexed, match],
  );

  // Seçenek listesi TÜM satırlardan türetilir (süzerken seçenekler kaybolmasın); sayaçlar ise
  // diğer aktif süzgeçlere göre hesaplanır.
  const facetOptions = React.useMemo(() => {
    const out = {} as Record<FacetKey, FacetOption[]>;
    for (const key of FACET_KEYS) {
      const map = new Map<string, FacetOption>();
      for (const item of indexed) {
        const value = item.keys[key];
        if (value === null || map.has(value)) continue;
        const label = FACET_LABEL[key](item.row);
        if (!label) continue;
        map.set(value, { value, label });
      }
      out[key] = [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'tr-TR'));
    }
    return out;
  }, [indexed]);

  const facetCounts = React.useMemo(() => {
    const out = {} as Record<FacetKey, Map<string, number>>;
    for (const key of FACET_KEYS) {
      const counts = new Map<string, number>();
      for (const item of indexed) {
        if (!match(item, key)) continue;
        const value = item.keys[key];
        if (value === null) continue;
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      out[key] = counts;
    }
    return out;
  }, [indexed, match]);

  /** Sunucu süzgeci etkin mi (boş sonuç metinleri ve dışa aktarma kapsamı bunu anlatır). */
  const serverFiltered = Boolean(filters.status || filters.from || filters.to || filters.search);
  const hasFilters = Boolean(q || FACET_KEYS.some((k) => facetValues[k].length > 0));

  /** Aktif süzgeçler — tek tek kaldırılabilir rozetler. */
  const activeChips = React.useMemo(() => {
    const chips: { id: string; label: string; remove: () => void }[] = [];
    if (q) chips.push({ id: 'q', label: `Arama: “${q}”`, remove: () => setQ('') });
    for (const key of FACET_KEYS) {
      for (const value of facetValues[key]) {
        // Liste yenilendiyse seçili değer artık bulunmayabilir; ham UUID/enum göstermek yerine
        // dürüst bir açıklama yazılır (rozet yine kaldırılabilir olsun).
        const label = facetOptions[key].find((o) => o.value === value)?.label ?? '(listede yok)';
        chips.push({
          id: `${key}:${value}`,
          label: `${FACET_TITLE[key]}: ${label}`,
          remove: () => setFacet(key, facetValues[key].filter((v) => v !== value)),
        });
      }
    }
    return chips;
  }, [q, facetValues, facetOptions, setFacet]);

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

  /** Yalnız YEREL süzgeçleri temizler (sunucu süzgeci kendi "temizle" düğmesindedir). */
  function reset() {
    setQ('');
    setFacetValues({ product: [], supplier: [], site: [] });
  }

  // ── Dışa aktarma paneli ───────────────────────────────────────────────────
  const [exportOpen, setExportOpen] = React.useState(false);
  const [scope, setScope] = React.useState<ExportScope>('visible');
  const [variant, setVariant] = React.useState<ExportVariant>('supplier');
  const [format, setFormat] = React.useState<ExportFormat>('csv');

  const exportRows = scope === 'visible' ? filtered : all;
  const spec = EXPORT_VARIANT[variant];

  function runExport() {
    if (!exportRows.length) return;
    const scopeTag = scope === 'visible' ? 'gorunen' : 'tumu';
    const base = `${spec.file}_${scopeTag}_${stamp()}`;
    if (format === 'csv') {
      // KVKK: uyarı satırı CSV'nin de İLK satırına yazılır (eskiden yalnız dosya adında vardı;
      // .txt sürümünde başlıkta olduğu için iki biçim arasında asimetri oluşuyordu). Tedarikçi
      // varyantında `spec.warning` YOK → o dosyaya uyarı basılmaz (kişisel veri içermiyor).
      downloadCsv(`${base}.csv`, toCsv(exportRows, spec.columns, spec.warning));
    } else {
      const header = [
        `Karantina — ${spec.title}`,
        `${exportRows.length} kayıt · ${scope === 'visible' ? 'süzülmüş liste' : 'tüm liste'} · ${fmtDateTime(new Date().toISOString())}`,
        ...(spec.warning ? [spec.warning] : []),
        '─'.repeat(52),
      ];
      downloadText(`${base}.txt`, toTextList(exportRows, spec.line, header));
    }
    setExportOpen(false);
  }

  return (
    <div className="space-y-4">
      <StatStrip
        items={[
          {
            icon: PackageX,
            label: 'Yüklenen kalem',
            value: all.length,
            hint: serverFiltered ? 'sunucu süzgeciyle' : undefined,
          },
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

      <QuarantineServerFilters filters={filters} limit={limit} />

      {truncated && (
        <Alert variant="warning">
          <ShieldAlert aria-hidden />
          <AlertDescription>
            Bu sorgu sunucu üst sınırına{limit ? ` (${limit.toLocaleString('tr-TR')} kayıt)` : ''}{' '}
            dayandı — süzgece uyan bazı (daha eski) kalemler listeye GİRMEMİŞ olabilir. Aşağıdaki
            sayılar ve dışa aktarmadaki <strong className="font-medium">Tümü</strong> seçeneği
            yalnız bu pencereyi kapsar. Eksiksiz liste için yukarıdaki{' '}
            <strong className="font-medium">sunucu süzgecini</strong> daraltın (durum, tarih aralığı
            veya arama) — bu süzgeçler veritabanındaki tüm kayıtlarda çalışır ve liste yeniden
            yüklenir.
          </AlertDescription>
        </Alert>
      )}

      <Card className="p-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="text-sm font-semibold text-foreground">Yüklenen liste içinde süz</h3>
            <p className="text-xs text-muted-foreground">
              Anında çalışır, yeniden yükleme yapmaz — kapsamı yukarıdaki sunucu süzgeci belirler.
            </p>
          </div>

          {/* Hızlı arama (yerel) */}
          <Field
            label="Listede hızlı ara"
            htmlFor="karantina-ara"
            className="max-w-lg"
            hint={`Yüklenen ${all.length.toLocaleString('tr-TR')} kayıt içinde: ürün, SKU, lisans değeri, müşteri, sipariş no, parti veya tedarikçi.`}
          >
            <SearchInput
              id="karantina-ara"
              value={q}
              onValueChange={setQ}
              placeholder="Yüklenen kalemlerde ara…"
              ariaLabel="Yüklenen karantina kalemlerinde ara"
              className="w-full"
              inputClassName="h-9"
            />
          </Field>

          {/* Faceted süzgeçler (DataTable araç çubuğuyla aynı bileşen ve görsel dil) */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-foreground/70" id="karantina-suzgec-etiket">
              Süz
            </span>
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-labelledby="karantina-suzgec-etiket"
            >
              {FACET_KEYS.map((key) => (
                <DataTableFacetedFilter
                  key={key}
                  column={facetColumn(key, facetCounts[key], facetValues[key], (values) =>
                    setFacet(key, values),
                  )}
                  title={FACET_TITLE[key]}
                  options={facetOptions[key]}
                />
              ))}
            </div>
          </div>

          {/* Aktif süzgeç rozetleri */}
          {activeChips.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Aktif süzgeçler:</span>
              {activeChips.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  onClick={chip.remove}
                  aria-label={`${chip.label} süzgecini kaldır`}
                  className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  {chip.label}
                  <X className="size-3" aria-hidden />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium tabular-nums text-foreground">{filtered.length}</span>
            {' / '}
            <span className="tabular-nums">{all.length}</span> kayıt gösteriliyor
            {hasFilters && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={reset}
                  className="rounded-sm text-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  Yerel süzgeçleri temizle
                </button>
              </>
            )}
          </p>

          <Popover open={exportOpen} onOpenChange={setExportOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" disabled={all.length === 0}>
                <Download aria-hidden />
                Dışa Aktar
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[22rem] space-y-3 p-3">
              <ChoiceGroup<ExportScope>
                legend="Hangi kayıtlar"
                name="karantina-export-kapsam"
                value={scope}
                onChange={setScope}
                options={[
                  {
                    value: 'visible',
                    label: `Görünen (süzülmüş) — ${filtered.length} kayıt`,
                    hint:
                      filtered.length === 0
                        ? 'Süzgeçlere uyan kayıt yok — “Yüklenen tümü”nü seçin ya da süzgeçleri gevşetin.'
                        : hasFilters
                          ? 'Yerel süzgeçlere uyanlar.'
                          : 'Şu an yerel süzgeç yok — yüklenen liste ile aynı.',
                    disabled: filtered.length === 0,
                  },
                  {
                    value: 'all',
                    label: `Yüklenen tümü — ${all.length} kayıt`,
                    // Dürüstlük: "tümü" = SUNUCUDAN GELEN pencere, veritabanının tamamı değil.
                    hint: serverFiltered
                      ? 'Sunucu süzgecinin döndürdüğü kayıtlar (veritabanının tamamı değil).'
                      : undefined,
                  },
                ]}
              />

              <ChoiceGroup<ExportVariant>
                legend="Hangi bilgiler"
                name="karantina-export-icerik"
                value={variant}
                onChange={setVariant}
                options={[
                  {
                    value: 'supplier',
                    label: 'Tedarikçi bildirimi',
                    hint: 'Ürün, SKU, tür, lisans değeri, durum, sebep, parti, tedarikçi, tarihler. Müşteri e-postası ve sipariş no YOK.',
                  },
                  {
                    value: 'audit',
                    label: 'İç denetim (tüm kolonlar)',
                    hint: 'Yukarıdakiler + site, sipariş no ve müşteri e-postası.',
                  },
                ]}
              />

              {spec.warning && (
                <Alert variant="warning" className="p-2.5">
                  <ShieldAlert aria-hidden />
                  <AlertDescription className="text-xs leading-snug">
                    Kişisel veri içerir — tedarikçiye/3. tarafa <strong>göndermeyin</strong>.
                    Yalnız panel içi denetim için kullanın.
                  </AlertDescription>
                </Alert>
              )}

              <ChoiceGroup<ExportFormat>
                legend="Dosya biçimi"
                name="karantina-export-bicim"
                value={format}
                onChange={setFormat}
                options={[
                  { value: 'csv', label: 'CSV (Excel)', hint: 'Excel/Numbers ile tablo olarak açılır.' },
                  {
                    value: 'txt',
                    label: 'Düz metin (.txt)',
                    hint: 'Ürün + anahtar + sebep; tedarikçi mesajına yapıştırmak için.',
                  },
                ]}
              />

              <Button
                type="button"
                className="w-full"
                onClick={runExport}
                disabled={exportRows.length === 0}
                aria-label={`${exportRows.length} kaydı ${spec.title} olarak ${format === 'csv' ? 'CSV' : 'düz metin'} indir`}
              >
                {format === 'csv' ? <FileSpreadsheet aria-hidden /> : <FileText aria-hidden />}
                {exportRows.length} kaydı indir
              </Button>
            </PopoverContent>
          </Popover>
        </div>
      </Card>

      <DataTable
        columns={columns}
        data={filtered}
        initialSorting={[{ id: 'quarantinedAt', desc: true }]}
        pageSize={50}
        emptyLabel={
          all.length === 0
            ? serverFiltered
              ? 'Sunucu süzgecine uyan kayıt yok — durumu/tarih aralığını gevşetin ya da aramayı değiştirin.'
              : 'Karantinada kalem yok — arızalı bildirilen lisanslar burada listelenir.'
            : 'Yerel süzgeçlere uyan kalem yok.'
        }
      />
    </div>
  );
}

/**
 * Faceted filtre köprüsü.
 *
 * `DataTableFacetedFilter` (paylaşılan bileşen) TanStack `Column` API'sinden YALNIZCA şu üç
 * üyeyi kullanır: `getFacetedUniqueValues()` · `getFilterValue()` · `setFilterValue()`.
 * Bu ekranda süzme tablonun İÇİNDE değil ebeveynde yapıldığı için (bkz. "Süzgeç modeli" notu)
 * ortada gerçek bir Column nesnesi yok — aşağıdaki köprü o üç üyeyi sağlar, böylece ikinci bir
 * facet bileşeni yazılmaz ve paylaşılan bileşene yapılacak stil değişiklikleri buraya da yansır.
 *
 * DİKKAT: paylaşılan bileşen başka bir `Column` üyesi kullanmaya başlarsa bu köprü de
 * genişletilmelidir (aksi halde çalışma anında `undefined is not a function`).
 */
function facetColumn(
  id: FacetKey,
  counts: Map<string, number>,
  selected: string[],
  onChange: (values: string[]) => void,
): Column<QuarantineItem, unknown> {
  const bridge: Pick<
    Column<QuarantineItem, unknown>,
    'id' | 'getFacetedUniqueValues' | 'getFilterValue' | 'setFilterValue'
  > = {
    id,
    getFacetedUniqueValues: () => counts,
    getFilterValue: () => (selected.length ? selected : undefined),
    setFilterValue: (updater) => {
      // Paylaşılan bileşen doğrudan değer geçirir; yine de fonksiyon biçimi (TanStack
      // `Updater`) desteklenir → ileride değişirse sessizce bozulmaz.
      const next = typeof updater === 'function' ? updater(selected) : updater;
      onChange(Array.isArray(next) ? (next as string[]) : []);
    },
  };
  return bridge as Column<QuarantineItem, unknown>;
}
