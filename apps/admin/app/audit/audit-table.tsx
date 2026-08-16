'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Eye,
  FileWarning,
  Info,
  KeyRound,
  LogIn,
  Mail,
  PackageCheck,
  PackagePlus,
  RefreshCw,
  Repeat2,
  ScrollText,
  Settings2,
  ShieldOff,
  Undo2,
  UserX,
  type LucideIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/page-header';
import { SearchInput } from '../../components/ui/search-input';
import { Skeleton } from '../../components/ui/skeleton';
import { selectClass } from '../../components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { auditActionLabel } from '../../lib/labels';
import { cn, fmtDateTime } from '../../lib/utils';
import { fetchAuditAction, type AuditEntry, type AuditPageData } from './actions';
import {
  AUDIT_ACTIONS,
  AUDIT_PAGE_SIZES,
  DEFAULT_AUDIT_PAGE_SIZE,
  TARGET_TYPE_OPTIONS,
  auditTargetHref,
  targetTypeLabel,
} from './constants';

/**
 * DENETİM İZİ TABLOSU (§8) — sunucu-taraflı süzgeç + sayfalama.
 *
 * NEDEN ORTAK `DataTable` KULLANILMADI: `components/data-table` istemci-taraflıdır (arama,
 * facet ve sayfalama YALNIZ elindeki diziye uygulanır). audit_log append-only ve hızlı büyüyen
 * bir tablo; tüm satırları istemciye indirmek mümkün değil. Sunucu sayfası + istemci sayfalaması
 * birlikte kullanılsaydı ekran "Sayfa 1/1" derken gerçekte binlerce kayıt gizli kalırdı — bu
 * projenin bilinen SESSİZ KIRPMA hata sınıfı. Bu yüzden süzgeç/arama/sayfalama uçtan uca
 * sunucudadır; envanter tablosunun (`components/inventory/license-items-table.tsx`) deseni.
 */

/**
 * ÖLÜ SÜZGEÇ DEĞERLERİ — `audit_action` enum'unda VAR ama hiçbir kod yolu YAZMIYOR.
 *
 * 'login': girişler `security_events`'e düşer (`admin-users.service`), `audit_log`'a değil →
 * seçilebilir bırakılırsa filtre DAİMA boş liste döndürür ve operatör bunu "giriş kaydı yok"
 * diye okur. Enum listesinin kendisi (`constants.ts`) BUDANMAZ: sunucu tarafı doğrulaması
 * enum'un tamamını kabul etmelidir (ileride yazılmaya başlarsa uç 400 vermesin) — elenen
 * yalnız açılır listedeki SEÇENEKtir.
 */
const DEAD_ACTIONS = new Set<string>(['login']);

/** Eylem → ikon. Etiket `lib/labels.ts` → `auditActionLabel` (TEK KAYNAK). */
const ACTION_ICON: Record<string, LucideIcon> = {
  reveal: Eye,
  replace: Repeat2,
  revoke: Undo2,
  suspend: ShieldOff,
  unsuspend: RefreshCw,
  import: PackagePlus,
  login: LogIn,
  assign: KeyRound,
  resend: Mail,
  site_update: Settings2,
  anonymize: UserX,
  receive: PackageCheck,
  recall: FileWarning,
  adjust: ClipboardList,
};

interface Filters {
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  traceId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = {
  actor: '',
  action: '',
  targetType: '',
  targetId: '',
  traceId: '',
  from: '',
  to: '',
};

/**
 * `<input type="date">` değerini (YYYY-MM-DD) gün SINIRINA çevirir.
 * Zaman dilimi eki (Z) BİLEREK yok: API `new Date(...)` ile SUNUCU saat diliminde (TZ
 * Europe/Istanbul) yorumlar → operatörün gördüğü gün ile süzülen gün aynı olur.
 */
function dayStart(v: string): string {
  return v ? `${v}T00:00:00` : '';
}
function dayEnd(v: string): string {
  return v ? `${v}T23:59:59.999` : '';
}

export function AuditTable({ initial }: { initial: AuditPageData | null }) {
  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS);
  /** Aktör kutusu tuş başına istek atmasın — sunucuya giden değer debounce'lanır. */
  const [actorTerm, setActorTerm] = React.useState('');
  const [pageSize, setPageSize] = React.useState<number>(DEFAULT_AUDIT_PAGE_SIZE);
  const [page, setPage] = React.useState(1);
  const [reloadKey, setReloadKey] = React.useState(0);

  const [data, setData] = React.useState<AuditPageData | null>(initial);
  // İlk veri sunucudan geldiyse açılışta iskelet gösterme (çift yükleme hissi olmasın).
  const [loading, setLoading] = React.useState(initial === null);
  const [error, setError] = React.useState<string | null>(null);

  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');

  React.useEffect(() => {
    const t = setTimeout(() => setActorTerm(filters.actor.trim()), 350);
    return () => clearTimeout(t);
  }, [filters.actor]);

  // Süzgeç/sayfa boyutu değişince ilk sayfaya dön — aksi halde boş sayfada kalınır.
  React.useEffect(() => {
    setPage(1);
  }, [
    actorTerm,
    filters.action,
    filters.targetType,
    filters.targetId,
    filters.traceId,
    filters.from,
    filters.to,
    pageSize,
  ]);

  // Yarışan yanıtlar: yalnız EN SON isteğin sonucu ekrana yazılır (eski yanıt üstüne binmez).
  const reqId = React.useRef(0);
  // İlk render'da sunucudan gelen veri varsa gereksiz ikinci isteği atlamak için işaret.
  const primed = React.useRef(initial !== null);
  React.useEffect(() => {
    if (primed.current) {
      primed.current = false;
      return;
    }
    const id = ++reqId.current;
    let cancelled = false;
    setLoading(true);
    fetchAuditAction({
      actor: actorTerm,
      action: filters.action,
      targetType: filters.targetType,
      targetId: filters.targetId.trim(),
      traceId: filters.traceId.trim(),
      from: dayStart(filters.from),
      to: dayEnd(filters.to),
      page,
      pageSize,
    })
      .then((res) => {
        if (cancelled || id !== reqId.current) return;
        if (res.ok) {
          setData(res.page);
          setError(null);
        } else {
          setError(res.error);
        }
      })
      .catch(() => {
        if (!cancelled && id === reqId.current) setError('Denetim kayıtları alınamadı.');
      })
      .finally(() => {
        if (!cancelled && id === reqId.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    actorTerm,
    filters.action,
    filters.targetType,
    filters.targetId,
    filters.traceId,
    filters.from,
    filters.to,
    page,
    pageSize,
    reloadKey,
  ]);

  const set = React.useCallback(
    <K extends keyof Filters>(key: K, value: Filters[K]) =>
      setFilters((f) => ({ ...f, [key]: value })),
    [],
  );

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const capped = data?.totalCapped ?? false;
  const pageCount = Math.max(1, Math.ceil(total / (data?.pageSize ?? pageSize)));
  const from = total === 0 ? 0 : (page - 1) * (data?.pageSize ?? pageSize) + 1;
  const to = total === 0 ? 0 : from + rows.length - 1;
  /**
   * Sayım kırpıldığında `pageCount` GERÇEK sayfa sayısından küçüktür → "Sonraki"yi ona göre
   * kilitlemek operatörü var olan kayıtlardan mahrum bırakırdı. Kırpılmışken ölçüt basit:
   * sayfa DOLU geldiyse arkasında en az bir kayıt daha var.
   */
  const hasNext = capped ? rows.length === (data?.pageSize ?? pageSize) : page < pageCount;
  const filtered =
    actorTerm !== '' ||
    filters.action !== '' ||
    filters.targetType !== '' ||
    filters.targetId.trim() !== '' ||
    filters.traceId.trim() !== '' ||
    filters.from !== '' ||
    filters.to !== '';

  return (
    <div className="space-y-4">
      {/* ── Süzgeçler (hepsi SUNUCUYA gider) ── */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <label htmlFor={`${uid}-actor`} className="text-xs font-medium text-foreground/70">
            Aktör
          </label>
          <SearchInput
            id={`${uid}-actor`}
            value={filters.actor}
            onValueChange={(v) => set('actor', v)}
            placeholder="panel:ali@ornek.com, wp:… (parça yazmak yeter)"
            ariaLabel="Aktör ara"
            className="w-full"
          />
        </div>
        <FilterSelect
          id={`${uid}-action`}
          label="Eylem"
          value={filters.action}
          onChange={(v) => set('action', v)}
          options={[
            { value: '', label: 'Tümü' },
            ...AUDIT_ACTIONS.filter((a) => !DEAD_ACTIONS.has(a)).map((a) => ({
              value: a,
              label: auditActionLabel(a),
            })),
          ]}
        />
        <FilterSelect
          id={`${uid}-ttype`}
          label="Hedef türü"
          value={filters.targetType}
          onChange={(v) => set('targetType', v)}
          options={[
            { value: '', label: 'Tümü' },
            ...TARGET_TYPE_OPTIONS.map((t) => ({ value: t, label: targetTypeLabel(t) })),
          ]}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-tid`} className="text-xs font-medium text-foreground/70">
            Hedef kimliği
          </label>
          <input
            id={`${uid}-tid`}
            value={filters.targetId}
            onChange={(e) => set('targetId', e.target.value)}
            placeholder="tam kimlik"
            className={cn(selectClass, 'h-8 w-44 cursor-text py-0 text-xs')}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-trace`} className="text-xs font-medium text-foreground/70">
            İz kimliği
          </label>
          <input
            id={`${uid}-trace`}
            value={filters.traceId}
            onChange={(e) => set('traceId', e.target.value)}
            placeholder="x-trace-id"
            className={cn(selectClass, 'h-8 w-44 cursor-text py-0 text-xs')}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-from`} className="text-xs font-medium text-foreground/70">
            Başlangıç
          </label>
          <input
            id={`${uid}-from`}
            type="date"
            value={filters.from}
            onChange={(e) => set('from', e.target.value)}
            className={cn(selectClass, 'h-8 w-auto py-0 text-xs')}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-to`} className="text-xs font-medium text-foreground/70">
            Bitiş
          </label>
          <input
            id={`${uid}-to`}
            type="date"
            value={filters.to}
            onChange={(e) => set('to', e.target.value)}
            className={cn(selectClass, 'h-8 w-auto py-0 text-xs')}
          />
        </div>
        <FilterSelect
          id={`${uid}-size`}
          label="Sayfada"
          value={String(pageSize)}
          onChange={(v) => setPageSize(Number(v))}
          options={AUDIT_PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} kayıt` }))}
        />
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
            Süzgeçleri sıfırla
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          aria-label="Listeyi yenile"
        >
          <RefreshCw aria-hidden className={loading ? 'animate-spin' : undefined} /> Yenile
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <Info />
          <div className="min-w-0 flex-1">
            <AlertTitle>Denetim kayıtları alınamadı</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </div>
        </Alert>
      )}

      {/* DÜRÜSTLÜK BANDI: sayım üst sınıra dayandıysa "N kayıt" demek YANLIŞ bilgi olurdu. */}
      {capped && (
        <Alert variant="info">
          <Info />
          <div className="min-w-0 flex-1">
            <AlertTitle>Sayım kırpıldı</AlertTitle>
            <AlertDescription>
              Süzgece uyan kayıt sayısı {data?.countCap ?? 0} sınırını aştı — toplam "en az"
              değerdir. Kesin sayı için aktör, eylem veya tarih aralığıyla daraltın.
            </AlertDescription>
          </div>
        </Alert>
      )}

      <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-xs">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead>Zaman</TableHead>
              <TableHead>Aktör</TableHead>
              <TableHead>Eylem</TableHead>
              <TableHead>Hedef</TableHead>
              <TableHead className="hidden lg:table-cell">İz kimliği</TableHead>
              <TableHead className="hidden xl:table-cell">Ayrıntı</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 6 }, (_, i) => (
                <TableRow key={`sk-${i}`} className="hover:bg-transparent">
                  <TableCell colSpan={6}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6}>
                  <EmptyState
                    icon={ScrollText}
                    title={filtered ? 'Bu süzgeçle kayıt yok' : 'Denetim kaydı yok'}
                    description={
                      filtered
                        ? 'Aktör, eylem veya tarih aralığını genişletmeyi deneyin.'
                        : 'Lisans görüntüleme, iptal, stok girişi ve giriş işlemleri burada birikir.'
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => <AuditRow key={row.id} row={row} />)
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── Sayaç + sayfalama ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {total === 0
            ? 'Kayıt yok'
            : `${capped ? `${total}+` : total} kayıttan ${from}-${to} arası gösteriliyor`}
        </p>
        <div className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            Sayfa {page}
            {capped ? '' : ` / ${pageCount}`}
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
            onClick={() => setPage((p) => p + 1)}
            disabled={loading || !hasNext}
            aria-label="Sonraki sayfa"
          >
            Sonraki <ChevronRight aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Tek denetim satırı. */
function AuditRow({ row }: { row: AuditEntry }) {
  const Icon = ACTION_ICON[row.action] ?? ScrollText;
  const href = auditTargetHref(row.targetType, row.targetId, row.meta);
  const typeLabel = targetTypeLabel(row.targetType);
  // Kimlik uzun (uuid) — tabloyu şişirmesin diye kısaltılır, tamamı `title`da durur.
  const shortId = row.targetId ? `${row.targetId.slice(0, 8)}…` : '';
  const metaText =
    row.meta == null ? '' : JSON.stringify(row.meta, null, 2);

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
        {fmtDateTime(row.createdAt)}
      </TableCell>
      <TableCell className="max-w-48 truncate" title={row.actor}>
        {row.actor}
      </TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-foreground">
          <Icon className="size-3.5 text-muted-foreground" aria-hidden />
          {auditActionLabel(row.action)}
        </span>
      </TableCell>
      <TableCell>
        {row.targetType == null && row.targetId == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
            <span className="text-foreground">{typeLabel || '—'}</span>
            {row.targetId &&
              (href ? (
                <Link
                  href={href}
                  className="font-mono text-xs text-primary underline-offset-2 hover:underline"
                  title={row.targetId}
                >
                  {shortId}
                </Link>
              ) : (
                <span className="font-mono text-xs text-muted-foreground" title={row.targetId}>
                  {shortId}
                </span>
              ))}
          </span>
        )}
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        {row.traceId ? (
          <span className="font-mono text-xs text-muted-foreground" title={row.traceId}>
            {row.traceId.slice(0, 8)}…
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="hidden xl:table-cell">
        {metaText ? (
          // Native <details>: JS gerektirmez, ekran okuyucu dostu, satırı da şişirmez.
          <details className="max-w-md">
            <summary className="cursor-pointer text-xs text-muted-foreground">Göster</summary>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-2 text-[11px] leading-snug text-muted-foreground">
              {metaText}
            </pre>
          </details>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

/** Süzgeç açılır listesi — görünür etiket + native select (klavye/ekran okuyucu dostu). */
function FilterSelect({
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
