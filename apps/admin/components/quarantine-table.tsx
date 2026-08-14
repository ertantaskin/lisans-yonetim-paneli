'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Inbox,
  PackageX,
  RefreshCw,
  Send,
  ShieldAlert,
  X,
} from 'lucide-react';
import type { Column, ColumnDef } from '@tanstack/react-table';
import type {
  QuarantineFilterState,
  QuarantineItem,
  QuarantineRange,
  QuarantineStatusFilter,
} from '../app/quarantine/queries';
import { SEGMENTED_LIST, segmentedItem } from '../lib/segmented';
import { cn, fmtDateTime } from '../lib/utils';
import { claimOutcomeLabel, licenseItemStatusLabel, productKindLabel } from '../lib/labels';
import {
  downloadCsv,
  downloadText,
  stamp,
  toCsv,
  toTextList,
  type CsvColumn,
} from '../lib/csv';
import { Badge, ClaimOutcomeBadge, StatusBadge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Alert, AlertDescription } from './ui/alert';
import { Field } from './ui/field';
import { HelpNote } from './ui/help-note';
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

/**
 * BİLDİRİM DURUMU — "bu kusurlu kalemi tedarikçiye bildirdim mi?".
 *
 * Kullanıcı geri bildirimi: sekme "Bildirilecekler 1" derken tablo 16 satır gösteriyordu ve
 * aradaki farkın nereden geldiği ekranda HİÇBİR YERDE yazmıyordu. Artık her satır kendi
 * bildirim durumunu taşır (kolon + hızlı süzgeç).
 *
 * Yüklem sunucudaki `claimed` süzgeciyle BİREBİR aynı: reddedilen kalem havuza döndüğü için
 * `claimId` boş gelir → burada da "Bildirilmedi" görünür (bilinçli, aynı tanım).
 */
type ClaimState = 'none' | 'open' | 'resolved';

const CLAIM_STATE_LABEL: Record<ClaimState, string> = {
  none: 'Bildirilmedi',
  open: 'Fişte — yanıt bekliyor',
  resolved: 'Tedarikçi yanıtladı',
};

function claimState(r: QuarantineItem): ClaimState {
  if (!r.claimId) return 'none';
  return r.claimOutcome && r.claimOutcome !== 'pending' ? 'resolved' : 'open';
}

/**
 * Durum rozeti — panelin TEK rozet bileşenine (`StatusBadge`) devredilir.
 *
 * Burada yerel bir ton sözlüğü VARDI ve `voided`'ı AMBER basıyordu; aynı durum lisans
 * envanterinde ve sipariş ekranlarında KIRMIZI görünüyordu (ölü kayıt). Tek kaynağa
 * bağlanınca ton/ikon/etiket panel geneliyle aynı olur.
 */
function QuarantineStatus({ status }: { status?: string | null }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  return <StatusBadge status={status} />;
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
        // 32px dokunma hedefi (icon-sm) — `size-7` ezmesi 28px'e düşürüyordu.
        className="shrink-0"
        onClick={copy}
        aria-label={copied ? 'Kopyalandı' : 'Kalem değerini kopyala'}
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
    meta: { title: 'Kalem durumu' },
    header: 'Kalem durumu',
    enableSorting: false,
    cell: ({ row }) => <QuarantineStatus status={row.original.status} />,
  },
  {
    id: 'claim',
    accessorFn: (r) => claimState(r),
    meta: { title: 'Tedarikçiye bildirim' },
    header: 'Tedarikçiye bildirim',
    enableSorting: false,
    cell: ({ row }) => {
      const r = row.original;
      if (!r.claimId) {
        return (
          <Badge variant="outline" title="Henüz bir değişim fişine girmedi.">
            {CLAIM_STATE_LABEL.none}
          </Badge>
        );
      }
      return (
        <div className="flex min-w-0 flex-col gap-0.5">
          <Link
            href={`/quarantine/claims/${r.claimId}`}
            className="truncate font-mono text-xs text-foreground underline-offset-4 hover:underline"
          >
            {r.claimCode ?? 'Fişi aç'}
          </Link>
          {r.claimOutcome && <ClaimOutcomeBadge outcome={r.claimOutcome} />}
        </div>
      );
    },
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
            // Tedarikçi karnesine kısa yol: "bu partiden şu kalemler bozuk" konuşmasını
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
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
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
    meta: { title: 'Kusur tarihi' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Kusur tarihi" />,
    // Kendi sıralayıcımız: `datetime` sortingFn null/boş tarihte patlar (bu alan null olabilir).
    sortingFn: (a, b) => ts(a.original.quarantinedAt) - ts(b.original.quarantinedAt),
    cell: ({ row }) => (
      <span className="whitespace-nowrap tabular-nums text-muted-foreground">
        {showDate(row.original.quarantinedAt)}
      </span>
    ),
  },
];

// ── Süzgeç modeli (İKİ KATMAN, TEK ARAÇ ÇUBUĞU) ─────────────────────────────
// 1) SUNUCU süzgeci — durum · tarih aralığı · arama. URL'de taşınır, sayfa sunucuda yeniden
//    render edilir; sorgu veritabanındaki TÜM kayıtları tarar (yalnız yüklenen pencereyi değil),
//    sonuç en fazla `limit` kayıttır → kırpılırsa uyarı.
// 2) YEREL (hızlı) süzgeç — facet'ler + anlık arama; yalnız YÜKLENEN pencere içinde.
//
// SUNUM KARARI (kullanıcı geri bildirimi: "çok karışık"): bu iki katman eskiden İKİ AYRI KART
// ve İKİ AYRI ARAMA KUTUSU olarak duruyordu ("Sunucu süzgeci" / "Yüklenen liste içinde süz").
// Operatör hangi kutuya yazacağını bilmiyordu. Artık TEK kart + TEK arama kutusu var:
//   yazdıkça  → yüklenen listede anında süzer (yerel)
//   Enter/düğme → veritabanındaki tüm kayıtlarda arar (sunucu) ve liste yeniden yüklenir
// Katmanların teknik farkı kaybolmadı, yalnız "Nasıl çalışır?" kutusuna taşındı.
//
// Yerel süzme TABLONUN İÇİNDE değil BURADA yapılır (bkz. queries.ts notu): dışa aktarmanın
// "görünen N kayıt" sayısı ancak süzülmüş küme tek yerde tutulursa dürüst olur.

type FacetKey = 'product' | 'supplier' | 'site' | 'claim';

const FACET_KEYS: FacetKey[] = ['claim', 'product', 'supplier', 'site'];

const FACET_TITLE: Record<FacetKey, string> = {
  claim: 'Bildirim',
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
  claim: (r) => claimState(r),
  product: (r) => r.productId ?? r.productName ?? null,
  supplier: (r) => r.supplierId ?? (r.supplierName ? `name:${r.supplierName}` : NO_SUPPLIER),
  site: (r) => r.siteDomain ?? null,
};

/** Süzgeç değerinin ekranda görünecek Türkçe karşılığı (ham enum/UUID ASLA çıkmaz). */
const FACET_LABEL: Record<FacetKey, (r: QuarantineItem) => string> = {
  claim: (r) => CLAIM_STATE_LABEL[claimState(r)],
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

// ── Dışa aktarma: İKİ AYRI İÇERİK ───────────────────────────────────────────
// Bu ekranın ana işi "çalışmayan kalemlerin listesini TEDARİKÇİYE ilet". O dosyada müşteri
// e-postası ve mağaza sipariş numarası İŞİ GÖRMEZ ama 3. tarafa kişisel veri taşır (KVKK) —
// üstelik TAM düz lisans değeriyle AYNI satırda birleşir. Bu yüzden dışa aktarma ikiye ayrıldı:
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
  { header: 'Kusur tarihi', value: (r) => csvDate(r.quarantinedAt) },
];

/** İç denetim — tedarikçi seti + izleme kolonları. KİŞİSEL VERİ İÇERİR (müşteri e-postası). */
const auditCsvColumns: CsvColumn<QuarantineItem>[] = [
  ...supplierCsvColumns,
  { header: 'Bildirim durumu', value: (r) => CLAIM_STATE_LABEL[claimState(r)] },
  { header: 'Fiş no', value: (r) => r.claimCode ?? '' },
  { header: 'Tedarikçi yanıtı', value: (r) => (r.claimOutcome ? claimOutcomeLabel(r.claimOutcome) : '') },
  { header: 'Mağaza sipariş no', value: (r) => r.remoteOrderId ?? r.sourceRemoteOrderId ?? '' },
  { header: 'Site', value: (r) => r.siteDomain ?? '' },
  { header: 'Müşteri e-postası', value: (r) => r.customerEmail ?? '' },
];

/**
 * Düz metin satırı — tedarikçiye mesajda YAPIŞTIRMAK için: ürün + değer + sebep.
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
    file: 'kusurlu-stok-tedarikci',
    columns: supplierCsvColumns,
    line: supplierTextLine,
  },
  audit: {
    title: 'İç denetim',
    file: 'kusurlu-stok-ic-denetim',
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
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const all = React.useMemo(() => rows ?? [], [rows]);

  // TEK arama kutusu: yazdıkça yerel süzer, Enter/düğme ile sunucuya gider.
  // Sunucudan gelen değerle senkronlanır (tarayıcı geri/ileri tuşu doğru çalışsın).
  const [q, setQ] = React.useState(filters.search);
  const [term, setTerm] = React.useState(filters.search);
  const [range, setRange] = React.useState<QuarantineRange>(filters.range);
  const [from, setFrom] = React.useState(filters.from);
  const [to, setTo] = React.useState(filters.to);

  React.useEffect(() => {
    setQ(filters.search);
    setRange(filters.range);
    setFrom(filters.from);
    setTo(filters.to);
  }, [filters.search, filters.range, filters.from, filters.to]);

  const [facetValues, setFacetValues] = React.useState<Record<FacetKey, string[]>>({
    claim: [],
    product: [],
    supplier: [],
    site: [],
  });

  const setFacet = React.useCallback((key: FacetKey, values: string[]) => {
    setFacetValues((prev) => ({ ...prev, [key]: values }));
  }, []);

  // Yazma sırasında 5000 satırlık süzme + facet sayaçları her tuşta koşmasın.
  React.useEffect(() => {
    const t = window.setTimeout(() => setTerm(q.trim()), 180);
    return () => window.clearTimeout(t);
  }, [q]);

  const needle = React.useMemo(() => lower(term), [term]);

  const go = React.useCallback(
    (next: Partial<QuarantineFilterState>) => {
      // Kutuda YAZILI olan metin ve seçili aralık düğmesi her gezinmede taşınır: operatör
      // yazdığını ya da seçtiğini sessizce kaybetmesin. Tarih DEĞERLERİ bilinçli taslak kalır
      // — "Uygula" ile gider.
      const merged = { ...filters, search: q.trim(), range, ...next };
      const params = new URLSearchParams();
      if (merged.status) params.set('status', merged.status);
      if (merged.range) params.set('range', merged.range);
      if (merged.from) params.set('from', merged.from);
      if (merged.to) params.set('to', merged.to);
      if (merged.search) params.set('q', merged.search);
      const qs = params.toString();
      // Sunucu süzgeçleri "Tüm Kayıtlar" ROTASINDA yaşar (bu tablo yalnız orada render edilir).
      // Eskiden `/quarantine`e push ediliyordu; üç bölüm ayrı rota olunca o adres havuzdur ve
      // süzgeç uygulanınca operatör başka bir ekrana atlamış olurdu.
      startTransition(() =>
        router.push(qs ? `/quarantine/records?${qs}` : '/quarantine/records'),
      );
    },
    [filters, router, q, range],
  );

  function pickRange(value: QuarantineRange) {
    setRange(value);
    // Özel aralık: tarihler girilip "Uygula"ya basılınca gider (her tıkta istek atma).
    if (value === 'custom') return;
    if (value === '') return go({ range: '', from: '', to: '' });
    go({ range: value, from: isoDay(new Date(Date.now() - Number(value) * 86_400_000)), to: '' });
  }

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
            r.claimCode,
          ]
            .filter(Boolean)
            .join(' '),
        ),
        keys: {
          claim: FACET_VALUE.claim(r),
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
  // "Yerel süzgeç var mı" = sunucu aramasının ÜSTÜNE eklenmiş bir daraltma var mı. Arama kutusu
  // sunucu terimini de gösterdiği için `term !== filters.search` karşılaştırması şart: aksi halde
  // yalnız sunucuda arama yapıldığında da "hızlı süzgeçleri temizle" beliriyor ve hiçbir şey yapmıyordu.
  const hasLocalFilters = Boolean(
    term !== filters.search || FACET_KEYS.some((k) => facetValues[k].length > 0),
  );

  /** Aktif YEREL süzgeçler — tek tek kaldırılabilir rozetler. */
  const activeChips = React.useMemo(() => {
    const chips: { id: string; label: string; remove: () => void }[] = [];
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
  }, [facetValues, facetOptions, setFacet]);

  const counts = React.useMemo(() => {
    let none = 0;
    let open = 0;
    let resolved = 0;
    let noSupplier = 0;
    for (const r of all) {
      const st = claimState(r);
      if (st === 'none') none += 1;
      else if (st === 'open') open += 1;
      else resolved += 1;
      if (!r.supplierId && !r.supplierName) noSupplier += 1;
    }
    return { none, open, resolved, noSupplier };
  }, [all]);

  /** Yalnız YEREL süzgeçleri temizler (sunucu araması kendi rozetinden kaldırılır). */
  function resetLocal() {
    setQ(filters.search);
    setFacetValues({ claim: [], product: [], supplier: [], site: [] });
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
        `Kusurlu stok — ${spec.title}`,
        `${exportRows.length} kayıt · ${scope === 'visible' ? 'süzülmüş liste' : 'tüm liste'} · ${fmtDateTime(new Date().toISOString())}`,
        ...(spec.warning ? [spec.warning] : []),
        '─'.repeat(52),
      ];
      downloadText(`${base}.txt`, toTextList(exportRows, spec.line, header));
    }
    setExportOpen(false);
  }

  const rangeLabel = rangeSummary(filters);

  return (
    <div className="space-y-4">
      <StatStrip
        items={[
          {
            icon: PackageX,
            label: 'Kusurlu kalem',
            value: all.length,
            hint: serverFiltered ? 'süzülmüş' : undefined,
          },
          {
            icon: Inbox,
            label: 'Bildirilmedi',
            value: counts.none,
            tone: counts.none > 0 ? 'warning' : 'default',
            hint: counts.noSupplier > 0 ? `${counts.noSupplier} tanesinin tedarikçisi yok` : undefined,
          },
          { icon: Send, label: 'Fişte, yanıt bekliyor', value: counts.open },
          {
            icon: Check,
            label: 'Tedarikçi yanıtladı',
            value: counts.resolved,
            tone: counts.resolved > 0 ? 'success' : 'default',
          },
        ]}
      />

      <HelpNote title="Bu liste ne gösteriyor, süzgeçler nasıl çalışıyor?">
        <p>
          Bu bölüm <strong>değişmez bir defterdir</strong>: arızalı bildirilen, değiştirilen veya
          geçersiz kılınan TÜM kalemler — bildirilmiş olsun olmasın — burada durur. İş listesi
          değildir; yapılacak işler{' '}
          <Link href="/quarantine" className="font-medium underline underline-offset-4">
            “Bildirilecekler”
          </Link>{' '}
          bölümündedir.
        </p>
        <p>
          <strong>Arama kutusu iki iş yapar:</strong> yazdıkça yüklenen listeyi anında süzer
          (lisans değeri ve sebep metni dahil); <strong>Enter</strong>&apos;a basarsanız
          veritabanındaki tüm kayıtlarda arar ve liste yeniden yüklenir. Durum ve tarih süzgeçleri
          de her zaman <strong>tüm kayıtlarda</strong> çalışır; tek seferde en fazla{' '}
          {(limit ?? 5000).toLocaleString('tr-TR')} kayıt gelir (sığmazsa uyarı çıkar).{' '}
          <strong>Bildirim / Ürün / Tedarikçi / Site</strong> hızlı süzgeçleri ise yalnız yüklenen
          liste içinde çalışır.
        </p>
        <p>
          <strong>Kusur tarihi</strong> kalemin öldüğü an, <strong>stok giriş tarihi</strong> ise
          partinin panele girildiği andır — ikisi farklı kavramdır, süzgeç kusur tarihine bakar.
        </p>
      </HelpNote>

      {truncated && (
        <Alert variant="warning">
          <ShieldAlert aria-hidden />
          <AlertDescription>
            Bu sorgu sunucu üst sınırına{limit ? ` (${limit.toLocaleString('tr-TR')} kayıt)` : ''}{' '}
            dayandı — süzgece uyan bazı (daha eski) kalemler listeye GİRMEMİŞ olabilir. Aşağıdaki
            sayılar ve dışa aktarmadaki <strong className="font-medium">Tümü</strong> seçeneği
            yalnız bu pencereyi kapsar. Eksiksiz liste için durumu, tarih aralığını ya da aramayı
            daraltın — bunlar veritabanındaki tüm kayıtlarda çalışır ve liste yeniden yüklenir.
          </AlertDescription>
        </Alert>
      )}

      <Card className="p-4" aria-busy={pending}>
        <div className="flex flex-col gap-3">
          {/* ── Arama (tek kutu, iki kapsam) ── */}
          {/* Araç çubuğu TEK ölçek rejiminde (h-8): SearchInput varsayılanı + size="sm" düğmeler.
              Eskiden aynı formda h-9 arama / h-9-ama-12px düğme / h-8 tarih girdisi yan yanaydı. */}
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              go({ search: q.trim() });
            }}
          >
            <Field
              label="Ara"
              htmlFor="kusurlu-ara"
              className="min-w-0 sm:max-w-xl"
              hint="Yazdıkça yüklenen listede süzer. Enter’a basarsanız veritabanındaki tüm kayıtlarda arar (lisans değeri şifreli olduğu için sunucuda aranmaz)."
            >
              {/* Kutu + "Tüm kayıtlarda ara" AYNI satırda: ipucu ikisinin de altında kalır.
                  (items-end ile düğme iki satırlık ipucunun altına hizalanıyordu.) */}
              <div className="flex flex-wrap items-center gap-2">
                <SearchInput
                  id="kusurlu-ara"
                  value={q}
                  onValueChange={setQ}
                  placeholder="Ürün, SKU, müşteri, sipariş no, parti, tedarikçi, fiş no…"
                  ariaLabel="Kusurlu stok kayıtlarında ara"
                  className="min-w-0 flex-1"
                />
                <Button type="submit" size="sm" variant="outline" disabled={pending}>
                  Tüm kayıtlarda ara
                </Button>
                {pending && (
                  <span className="inline-flex h-8 items-center gap-1 text-xs text-muted-foreground">
                    <RefreshCw className="size-3 animate-spin" aria-hidden />
                    Yükleniyor…
                  </span>
                )}
              </div>
            </Field>
          </form>

          {/* ── Sunucu süzgeçleri: durum + kusur tarihi ── */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-foreground/70" id="kusurlu-durum-etiket">
                Kalem durumu
              </span>
              {/* Görünüm TEK KAYNAK lib/segmented.ts: bu bir "kümeden tek seçim" çubuğudur ve
                  eskiden dolu/outline Button çiftiyle çiziliyordu — aynı anlamı taşıyan sekme ve
                  bölüm çubuklarından farklı görünüyordu. Semantik korunur (role=group + aria-pressed). */}
              <div className={SEGMENTED_LIST} role="group" aria-labelledby="kusurlu-durum-etiket">
                {STATUS_FILTERS.map((s) => (
                  <button
                    key={s.value || 'all'}
                    type="button"
                    className={segmentedItem(filters.status === s.value)}
                    aria-pressed={filters.status === s.value}
                    disabled={pending}
                    onClick={() => go({ status: s.value })}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-foreground/70" id="kusurlu-tarih-etiket">
                Kusur tarihi
              </span>
              {/* Görünüm TEK KAYNAK lib/segmented.ts (gerekçe: yukarıdaki durum çubuğu). */}
              <div className={SEGMENTED_LIST} role="group" aria-labelledby="kusurlu-tarih-etiket">
                {RANGE_PRESETS.map((p) => (
                  <button
                    key={p.value || 'all'}
                    type="button"
                    className={segmentedItem(range === p.value)}
                    aria-pressed={range === p.value}
                    disabled={pending}
                    onClick={() => pickRange(p.value)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {range === 'custom' && (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="kusurlu-baslangic"
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
                id="kusurlu-bitis"
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
                  from || to ? go({ range: 'custom', from, to }) : go({ range: '', from: '', to: '' })
                }
              >
                Uygula
              </Button>
            </div>
          )}

          {/* ── Yerel hızlı süzgeçler ── */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-foreground/70" id="kusurlu-suzgec-etiket">
              Hızlı süz
            </span>
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-labelledby="kusurlu-suzgec-etiket"
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

          {/* ── Aktif süzgeç rozetleri (sunucu + yerel tek satırda) ── */}
          {(activeChips.length > 0 || serverFiltered) && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Aktif süzgeçler:</span>
              {filters.search && (
                <FilterChip
                  label={`Tüm kayıtlarda: “${filters.search}”`}
                  disabled={pending}
                  onRemove={() => go({ search: '' })}
                />
              )}
              {filters.status && (
                <FilterChip
                  label={`Kalem durumu: ${statusText(filters.status)}`}
                  disabled={pending}
                  onRemove={() => go({ status: '' })}
                />
              )}
              {rangeLabel && (
                <FilterChip
                  label={`Kusur tarihi: ${rangeLabel}`}
                  disabled={pending}
                  onRemove={() => go({ range: '', from: '', to: '' })}
                />
              )}
              {/* Yerel facet çipleri AYNI çipe bağlandı (yan yana iki farklı görünüm vardı).
                  `disabled` GEÇİLMEZ: bunlar saf istemci süzgeci, sunucu gezinmesinde donmamalı. */}
              {activeChips.map((chip) => (
                <FilterChip key={chip.id} label={chip.label} onRemove={chip.remove} />
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium tabular-nums text-foreground">{filtered.length}</span>
            {' / '}
            <span className="tabular-nums">{all.length}</span> kayıt gösteriliyor
            {hasLocalFilters && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={resetLocal}
                  className="rounded-sm text-foreground underline underline-offset-4 hover:no-underline"
                >
                  Hızlı süzgeçleri temizle
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
                name="kusurlu-export-kapsam"
                value={scope}
                onChange={setScope}
                options={[
                  {
                    value: 'visible',
                    label: `Görünen (süzülmüş) — ${filtered.length} kayıt`,
                    hint:
                      filtered.length === 0
                        ? 'Süzgeçlere uyan kayıt yok — “Yüklenen tümü”nü seçin ya da süzgeçleri gevşetin.'
                        : hasLocalFilters
                          ? 'Hızlı süzgeçlere uyanlar.'
                          : 'Şu an hızlı süzgeç yok — yüklenen liste ile aynı.',
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
                name="kusurlu-export-icerik"
                value={variant}
                onChange={setVariant}
                options={[
                  {
                    value: 'supplier',
                    label: 'Tedarikçi bildirimi',
                    hint: 'Ürün, SKU, tür, lisans/hesap değeri, durum, sebep, parti, tedarikçi, tarihler. Müşteri e-postası ve sipariş no YOK.',
                  },
                  {
                    value: 'audit',
                    label: 'İç denetim (tüm kolonlar)',
                    hint: 'Yukarıdakiler + bildirim durumu, fiş no, site, sipariş no ve müşteri e-postası.',
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
                name="kusurlu-export-bicim"
                value={format}
                onChange={setFormat}
                options={[
                  { value: 'csv', label: 'CSV (Excel)', hint: 'Excel/Numbers ile tablo olarak açılır.' },
                  {
                    value: 'txt',
                    label: 'Düz metin (.txt)',
                    hint: 'Ürün + değer + sebep; tedarikçi mesajına yapıştırmak için.',
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
              ? 'Süzgece uyan kayıt yok — durumu/tarih aralığını gevşetin ya da aramayı değiştirin.'
              : 'Hiç kusurlu kalem yok — arızalı bildirilen lisans/hesap kalemleri burada listelenir.'
            : 'Hızlı süzgeçlere uyan kalem yok.'
        }
      />
    </div>
  );
}

/**
 * "Süzgeci kaldır" çipi — sunucu ve yerel süzgeçler İÇİN TEK görünüm.
 *
 * Eskiden iki ayrı uygulama vardı ve aynı satırda yan yana duruyorlardı: sunucu çipi saç teli
 * halkalıydı (ring-inset), yerel facet çipi halkasızdı. Halka değeri `ui/badge.tsx` `neutral`
 * varyantıyla hizalandı (`ring-border/70`) → rozet diliyle birebir aynı.
 *
 * `disabled` YALNIZ sunucu çiplerine geçirilir (useTransition bayrağı); yerel facet çipleri saf
 * istemci durumudur ve sunucu yeniden yüklemesi sırasında dondurulmamalıdır.
 */
function FilterChip({
  label,
  onRemove,
  disabled,
}: {
  label: string;
  onRemove: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onRemove}
      disabled={disabled}
      aria-label={`${label} süzgecini kaldır`}
      // Geometri `ui/badge.tsx` `neutral` ile BİREBİR (h-5 · px-2 · gap-1 · 12px/600):
      // bu çip rozetlerin yanında duruyor, yarım piksellik fark bile satırı tırtıklı gösterir.
      className="inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full bg-secondary px-2 text-xs font-semibold leading-none text-secondary-foreground ring-1 ring-inset ring-border/70 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
    >
      {label}
      <X className="size-3" aria-hidden />
    </button>
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
