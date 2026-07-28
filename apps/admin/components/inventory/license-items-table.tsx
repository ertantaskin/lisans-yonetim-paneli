'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import {
  fetchLicenseItemsAction,
  type LicenseInventoryPage,
  type LicenseInventoryRow,
} from '../../app/stock/license-actions';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/page-header';
import { SearchInput } from '../ui/search-input';
import { Skeleton } from '../ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { selectClass } from '../ui/input';
import type { PayloadFieldDef } from '../../lib/api';
import { cn, fmtDateTime } from '../../lib/utils';
import { assignmentStatusLabel, productKindLabel, siteTypeLabel } from '../../lib/labels';
import { LicenseItemActions, statusLabel } from './license-item-actions';

/** Sayfa boyutu seçenekleri — API bu üç değere kırpar (kullanıcının açık isteği). */
const PAGE_SIZES = [25, 50, 100] as const;

const STATUS_OPTIONS = [
  { value: '', label: 'Tümü' },
  { value: 'available', label: 'Stokta' },
  { value: 'assigned', label: 'Teslim edilen' },
  { value: 'quarantined', label: 'Karantinada' },
  { value: 'voided', label: 'Geçersiz kılındı' },
] as const;

const SORT_OPTIONS = [
  { value: 'created_desc', label: 'En yeni' },
  { value: 'created_asc', label: 'En eski' },
  { value: 'assigned_desc', label: 'Son teslim edilen' },
] as const;

/** license_items durumu → rozet tonu (durum dili: stokta yeşil, ölü kayıt kırmızı). */
const STATUS_VARIANT: Record<string, 'success' | 'neutral' | 'warning' | 'danger' | 'outline'> = {
  available: 'success',
  assigned: 'neutral',
  suspended: 'warning',
  replaced: 'neutral',
  expired: 'warning',
  quarantined: 'warning',
  depleted: 'outline',
  revoked: 'danger',
  voided: 'danger',
};

/** Gizli alan maskesi — uzunluk/biçim sızdırmayan sabit gövde (§8 mask deseni). */
const MASK = '••••••';

/**
 * Lisans envanteri tablosu — ürün detayında (`productId` verilir) ve /stock genel
 * listesinde (`showProductColumn`) AYNI bileşen kullanılır.
 *
 * Veri istemciden çekilir ama ADMIN_TOKEN tarayıcıya İNMEZ: `fetchLicenseItemsAction`
 * sunucu action'ı API'ye gider. Arama/filtre/sıralama/sayfalama SUNUCU tarafındadır
 * (LIMIT/OFFSET) → 100 satır seçilse bile istemciye yalnız o sayfa iner, ekran donmaz.
 */
export function LicenseItemsTable({
  productId,
  payloadSchema,
  showProductColumn = false,
  className,
}: {
  /** Verilirse yalnız bu ürünün kalemleri listelenir (ürün detayı). */
  productId?: string;
  /**
   * Hesap ürününün alan şeması — YALNIZ tek ürüne daraltılmış listede anlamlı
   * (ürün detayı). Global listede satırlar farklı ürünlerden gelir → gönderilmez.
   */
  payloadSchema?: PayloadFieldDef[] | null;
  /** Global listede ürün kolonu gösterilir (farklı ürünler karışık gelir). */
  showProductColumn?: boolean;
  className?: string;
}) {
  const [search, setSearch] = React.useState('');
  const [term, setTerm] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [sort, setSort] = React.useState<string>('created_desc');
  const [pageSize, setPageSize] = React.useState<number>(PAGE_SIZES[0]);
  const [page, setPage] = React.useState(1);
  const [reloadKey, setReloadKey] = React.useState(0);

  const [data, setData] = React.useState<LicenseInventoryPage | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Aynı sayfada birden çok envanter tablosu olabilir → etiket/kontrol id'leri benzersiz olmalı.
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');

  // Arama sunucuya gider → tuş başına istek atmamak için debounce.
  React.useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Süzgeç/sıralama/sayfa boyutu değişince ilk sayfaya dön (aksi halde boş sayfada kalınır).
  React.useEffect(() => {
    setPage(1);
  }, [term, status, sort, pageSize]);

  // Yarışan yanıtlar: yalnız EN SON isteğin sonucu ekrana yazılır (eski yanıt üzerine binmez).
  const reqId = React.useRef(0);
  React.useEffect(() => {
    const id = ++reqId.current;
    let cancelled = false;
    setLoading(true);
    fetchLicenseItemsAction({ productId, status, search: term, page, pageSize, sort })
      .then((res) => {
        if (cancelled || id !== reqId.current) return;
        if (res.ok && res.page) {
          setData(res.page);
          setError(null);
        } else {
          setError(res.error ?? 'Lisans listesi alınamadı.');
        }
      })
      .catch(() => {
        if (!cancelled && id === reqId.current) setError('Lisans listesi alınamadı.');
      })
      .finally(() => {
        if (!cancelled && id === reqId.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productId, status, term, page, pageSize, sort, reloadKey]);

  const reload = React.useCallback(() => setReloadKey((k) => k + 1), []);

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / (data?.pageSize ?? pageSize)));

  // Kayıt silinince son sayfa boşalabilir → geçerli aralığa çek.
  React.useEffect(() => {
    if (data && page > pageCount) setPage(pageCount);
  }, [data, page, pageCount]);

  const rows = data?.rows ?? [];
  const from = total === 0 ? 0 : (page - 1) * (data?.pageSize ?? pageSize) + 1;
  const to = total === 0 ? 0 : from + rows.length - 1;
  const colCount = showProductColumn ? 8 : 7;

  return (
    <div className={cn('space-y-3', className)}>
      {/* ── Üst çubuk: arama + süzgeçler ── */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <label htmlFor={`${uid}-search`} className="text-xs font-medium text-foreground/70">
            Ara
          </label>
          <SearchInput
            id={`${uid}-search`}
            value={search}
            onValueChange={setSearch}
            placeholder="Anahtarın son 5 hanesi, e-posta, sipariş no…"
            ariaLabel="Lisans ara"
            className="w-full"
          />
        </div>
        <ToolbarSelect
          id={`${uid}-status`}
          label="Durum"
          value={status}
          onChange={setStatus}
          options={STATUS_OPTIONS}
        />
        <ToolbarSelect
          id={`${uid}-sort`}
          label="Sıralama"
          value={sort}
          onChange={setSort}
          options={SORT_OPTIONS}
        />
        <ToolbarSelect
          id={`${uid}-size`}
          label="Sayfada"
          value={String(pageSize)}
          onChange={(v) => setPageSize(Number(v))}
          options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} kayıt` }))}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={reload}
          disabled={loading}
          aria-label="Listeyi yenile"
        >
          <RefreshCw aria-hidden className={loading ? 'animate-spin' : undefined} /> Yenile
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Anahtar araması gizlilik gereği yalnız <strong>son 5 hane</strong> üzerinden çalışır
        (kayıtlar şifreli saklanır). Müşteri e-postası, mağaza sipariş numarası ve parti kodu
        ile de arayabilirsiniz.
      </p>

      {error && (
        <Alert variant="destructive">
          <ShieldAlert aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* ── Tablo ── */}
      <div
        className="rounded-lg border border-border"
        aria-busy={loading}
      >
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {showProductColumn && <TableHead>Ürün</TableHead>}
              <TableHead>Lisans / Hesap</TableHead>
              <TableHead>Durum</TableHead>
              <TableHead>Kapasite</TableHead>
              <TableHead>Parti</TableHead>
              <TableHead>Teslimat</TableHead>
              <TableHead>Eklenme</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">İşlemler</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && rows.length === 0 ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={`sk-${i}`} className="hover:bg-transparent">
                  {Array.from({ length: colCount }).map((__, j) => (
                    <TableCell key={`sk-${i}-${j}`}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={colCount}>
                  <EmptyState
                    icon={KeyRound}
                    title={
                      term || status
                        ? 'Bu süzgeçlerle kayıt bulunamadı.'
                        : productId
                          ? 'Bu ürüne henüz lisans girilmemiş.'
                          : 'Henüz lisans yok.'
                    }
                    description={
                      term || status
                        ? 'Aramayı veya durum süzgecini değiştirip tekrar deneyin.'
                        : productId
                          ? 'Yukarıdaki “Key / Stok İçe Aktar” bölümünden bu ürüne lisans ekleyebilirsiniz.'
                          : 'Bir ürünün detay sayfasındaki “Key / Stok İçe Aktar” bölümünden lisans ekleyebilirsiniz.'
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id} className={cn('align-top', loading && 'opacity-60')}>
                  {showProductColumn && (
                    <TableCell className="max-w-48">
                      <Link
                        href={`/products/${row.productId}`}
                        className="block truncate font-medium text-foreground underline-offset-4 hover:underline"
                        title={row.productName}
                      >
                        {row.productName}
                      </Link>
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {row.productSku}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {productKindLabel(row.productType)}
                      </div>
                    </TableCell>
                  )}

                  <TableCell className="max-w-72">
                    <LicenseValueCell row={row} />
                  </TableCell>

                  <TableCell>
                    <Badge variant={STATUS_VARIANT[row.status] ?? 'neutral'}>
                      {statusLabel(row.status)}
                    </Badge>
                  </TableCell>

                  <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                    {row.usageMode === 'multi' ? (
                      <span title={`${row.useCount} kullanıldı / ${row.maxUses} toplam`}>
                        {row.useCount}/{row.maxUses}
                        <span className="block text-xs">kalan {row.remainingUses}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  <TableCell className="max-w-40">
                    {row.batchCode ? (
                      <>
                        <div className="truncate text-foreground/90" title={row.batchCode}>
                          {row.batchCode}
                        </div>
                        {row.supplierName && (
                          <div
                            className="truncate text-xs text-muted-foreground"
                            title={row.supplierName}
                          >
                            {row.supplierName}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  <TableCell className="max-w-64">
                    <DeliveryCell row={row} />
                  </TableCell>

                  <TableCell className="whitespace-nowrap tabular-nums text-xs text-muted-foreground">
                    {fmtDateTime(row.createdAt)}
                  </TableCell>

                  <TableCell className="text-right">
                    <LicenseItemActions
                      row={row}
                      payloadSchema={productId ? payloadSchema : undefined}
                      onDone={reload}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── Sayaç + sayfalama ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {total === 0
            ? 'Kayıt yok'
            : `${total} kalemden ${from}-${to} arası gösteriliyor`}
        </p>
        <div className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            Sayfa {page} / {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={loading || page <= 1}
            aria-label="Önceki sayfa"
          >
            <ChevronLeft aria-hidden /> Önceki
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            disabled={loading || page >= pageCount}
            aria-label="Sonraki sayfa"
          >
            Sonraki <ChevronRight aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Üst çubuk süzgeci — görünür etiket + native select (klavye/ekran okuyucu dostu). */
function ToolbarSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-foreground/70">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(selectClass, 'h-8 w-auto py-0 text-xs')}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Lisans/hesap hücresi. Panel kimlik-doğrulamalı olduğu için değer AÇIK gösterilir
 * (sipariş detayı ile aynı politika); yalnız hesap ürününün "gizli" alanları (parola)
 * varsayılan olarak maskelenir — omuz-sörfü riskini azaltır, tek tıkla açılır.
 */
function LicenseValueCell({ row }: { row: LicenseInventoryRow }) {
  const [shown, setShown] = React.useState(false);
  const hasSecret = (row.fields ?? []).some((f) => f.secret);

  if (row.kind === 'account') {
    if (!row.fields || row.fields.length === 0) {
      return <span className="text-xs text-muted-foreground">Hesap alanları okunamadı</span>;
    }
    const copyText = row.fields
      .map((f) => `${f.label}: ${f.value}`)
      .join('\n');
    return (
      <div className="space-y-1">
        {row.fields.map((f) => (
          <div key={f.key} className="flex gap-1.5 text-xs">
            <span className="shrink-0 text-muted-foreground">{f.label}:</span>
            <span
              className="truncate font-mono text-foreground/90"
              title={f.secret && !shown ? 'Gizli alan — göstermek için Göster' : f.value}
            >
              {f.secret && !shown ? MASK : f.value}
            </span>
          </div>
        ))}
        <div className="flex items-center gap-1 pt-0.5">
          {hasSecret && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs"
              onClick={() => setShown((s) => !s)}
              aria-label={shown ? 'Gizli alanları gizle' : 'Gizli alanları göster'}
            >
              {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
              {shown ? 'Gizle' : 'Göster'}
            </Button>
          )}
          <CopyButton text={copyText} label="Hesap bilgilerini kopyala" />
        </div>
      </div>
    );
  }

  if (!row.value) {
    return <span className="text-xs text-muted-foreground">Lisans okunamadı</span>;
  }
  return (
    <div className="flex items-start gap-1">
      <code
        className="block flex-1 truncate font-mono text-sm text-foreground/90"
        title={row.value}
      >
        {row.value}
      </code>
      <CopyButton text={row.value} label="Lisans anahtarını kopyala" />
    </div>
  );
}

/** Panoya kopyala + kısa geri bildirim (izin yoksa dürüst uyarı). */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = React.useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('ok');
    } catch {
      setState('fail');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1600);
  }

  return (
    <span className="inline-flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-6 shrink-0"
        onClick={copy}
        aria-label={label}
        title={label}
      >
        {state === 'ok' ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
      {state !== 'idle' && (
        <span
          role="status"
          className={cn('text-xs', state === 'ok' ? 'text-success' : 'text-destructive')}
        >
          {state === 'ok' ? 'Kopyalandı' : 'Kopyalanamadı'}
        </span>
      )}
    </span>
  );
}

/**
 * Teslimat hücresi — kalem bir siparişe verilmişse müşteri/site/sipariş bağlantısı.
 * Mağaza linki (`storeAdminUrl`) YALNIZ backend üretebildiyse görünür ve yeni sekmede
 * açılır: panel mağazaya bağlanmaz/oturum açmaz, SALT URL yönlendirmesidir (§17).
 */
function DeliveryCell({ row }: { row: LicenseInventoryRow }) {
  const d = row.delivered;
  if (!d) return <span className="text-muted-foreground">—</span>;

  return (
    <div className="space-y-0.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Link
          href={`/orders/${d.orderId}`}
          className="font-medium tabular-nums text-foreground underline-offset-4 hover:underline"
          title="Panelde sipariş detayını aç"
        >
          #{d.remoteOrderId || '—'}
        </Link>
        {d.storeAdminUrl && (
          <a
            href={d.storeAdminUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            title={`${siteTypeLabel(d.siteType) || 'Mağaza'} panelinde aç`}
            aria-label={`Siparişi ${d.siteDomain} mağaza panelinde yeni sekmede aç`}
          >
            <ExternalLink className="size-3" aria-hidden />
            Mağazada aç
          </a>
        )}
      </div>
      {d.customerEmail && (
        <div className="truncate text-foreground/90" title={d.customerEmail}>
          {d.customerEmail}
        </div>
      )}
      <div className="truncate text-muted-foreground" title={d.siteDomain}>
        {d.siteDomain || '—'}
      </div>
      <div className="tabular-nums text-muted-foreground">
        {d.assignedAt ? fmtDateTime(d.assignedAt) : '—'}
        {d.validUntil && <> · bitiş {fmtDateTime(d.validUntil)}</>}
      </div>
      {d.assignmentStatus !== 'active' && (
        <div className="text-muted-foreground">{assignmentStatusLabel(d.assignmentStatus)}</div>
      )}
    </div>
  );
}
