'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import {
  bulkAdjustLicenseItemsAction,
  fetchLicenseItemsAction,
  type LicenseInventoryPage,
  type LicenseInventoryRow,
} from '../../app/stock/license-actions';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge, StatusBadge } from '../ui/badge';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { useConfirm } from '../ui/confirm';
import { useAnnouncer } from '../a11y/announcer';
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
import { LICENSE_PAGE_SIZES } from '../../lib/license-page-sizes';
import type { PayloadFieldDef } from '../../lib/api';
import { cn, fmtDateTime } from '../../lib/utils';
import { assignmentStatusLabel, productKindLabel, siteTypeLabel } from '../../lib/labels';
import { LicenseItemActions, statusLabel } from './license-item-actions';

/** Sayfa boyutu seçenekleri — TEK KAYNAK lib/license-page-sizes (API bu değerlere kırpar). */
const PAGE_SIZES = LICENSE_PAGE_SIZES;

/**
 * Durum süzgeci. ETİKETLER TEK KAYNAKTAN (`lib/labels` → statusLabel) gelir — burada yalnız
 * hangi durumların sunulacağı seçilir; ham enum kullanıcıya ÇIKMAZ.
 * 'expired' = STOK ÖMRÜ dolmuş kalem (API bu süzgeci `status='expired'` VEYA `expires_at ≤ now`
 * olarak yorumlar) — "stokta görünüp satılamayan" kalemleri tek listede toplar.
 */
const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Tümü' },
  ...['available', 'assigned', 'expired', 'quarantined', 'voided'].map((v) => ({
    value: v,
    label: statusLabel(v),
  })),
];

/**
 * "Kim tutuyor" ekseni — envanter DURUMUNDAN ayrıdır. Çok kullanımlı (MAK) bir anahtar
 * 500 hakkının 3'ü satılmışken hâlâ `status='available'` görünür, yani "müşterilerde mi?"
 * sorusu durum süzgeciyle cevaplanamaz. Geri çekilmiş bir partide "hangi anahtarlar hâlâ
 * müşterilerin elinde, hangisini değiştirmeliyim" sorusunun tek doğru süzgeci budur.
 */
const HOLDER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Tümü' },
  { value: 'customer', label: 'Müşterilerde' },
];

/**
 * Sıralama seçenekleri. "En yeni giriş üstte" = giriş BLOKLARI en yeniden eskiye,
 * blok İÇİNDE operatörün yapıştırdığı sıra korunur (sunucu: `created_at DESC, seq ASC`).
 * Etiketler bunu açıkça söyler — eskiden yalnız "En yeni" yazıyordu ve aynı içe aktarmanın
 * satırları rastgele sırada geldiği için operatör listesini tanıyamıyordu.
 */
const SORT_OPTIONS = [
  { value: 'created_desc', label: 'En yeni giriş üstte' },
  { value: 'created_asc', label: 'En eski giriş üstte' },
  { value: 'assigned_desc', label: 'Son teslim edilen' },
] as const;

// NOT: Bu dosyada yerel bir durum→ton sözlüğü VARDI ve ikonsuz düz `Badge` basıyordu →
// aynı "Teslim edildi" durumu /orders'ta yeşil-ikonlu, burada gri-ikonsuz görünüyordu
// (`quarantined` de burada amber, orada kırmızıydı). Artık panelin TEK rozet bileşeni
// `StatusBadge` kullanılıyor: ton + ikon + Türkçe etiket tek kaynaktan (`ui/badge` +
// `lib/labels`). Yeni bir durum eklenecekse oraya eklenir, buraya değil.

/** Gizli alan maskesi — uzunluk/biçim sızdırmayan sabit gövde (§8 mask deseni). */
const MASK = '••••••';

/** Hâlâ "satılabilir" görünen durumlar — stok ömrü dolmuşsa UYARI tonu bunlarda gösterilir. */
const SELLABLE_STATUS = new Set(['available', 'reserved']);

/**
 * GLUE — stok ömrü alanlarının SAVUNMACI okunması.
 *
 * API satırda `expired: boolean` + `expiresAt` döndürür (stock.service.LicenseInventoryRow);
 * admin tarafındaki tip (`app/stock/license-actions.ts`) bu partide DEĞİŞMEDİĞİ için alanlar
 * tipte yok → burada dar bir cast ile okunur. Alan gelmezse (api/admin deploy sapması, eski
 * sürüm) hiçbir şey gösterilmez: bugünkü davranış aynen korunur, ekran KIRILMAZ.
 *
 * NOT: `expired` istemci saatine göre HESAPLANMAZ — sunucudan gelir (tek doğruluk kaynağı).
 */
function stockExpiry(row: LicenseInventoryRow): { expired: boolean; expiresAt: string | null } {
  const r = row as unknown as { expired?: unknown; expiresAt?: unknown };
  const expiresAt = typeof r.expiresAt === 'string' && r.expiresAt.trim() ? r.expiresAt : null;
  return { expired: r.expired === true, expiresAt };
}

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
  batchId,
  lockedHolder,
  refreshKey,
  onMutated,
  payloadSchema,
  showProductColumn = false,
  defaultPageSize,
  className,
}: {
  /** Verilirse yalnız bu ürünün kalemleri listelenir (ürün detayı). */
  productId?: string;
  /** Verilirse yalnız bu PARTİYE ait kalemler listelenir (parti detayı). */
  batchId?: string;
  /**
   * Verilirse tablo bu kapsama KİLİTLENİR ve süzgeç kontrolü gösterilmez — kartın başlığı
   * zaten kapsamı söylüyordur (ör. parti detayındaki "Müşterilerdeki lisanslar" kartı).
   */
  lockedHolder?: 'customer';
  /**
   * KARDEŞ TABLO TAZELEME. Aynı sayfada bu tablodan İKİ tane olabilir (parti detayı:
   * "Müşterilerdeki lisanslar" + "Bu partideki lisanslar") ve aynı kalem ikisinde de
   * listelenir. Biri üzerinden değişim/geçersiz kılma yapılınca DİĞERİ bayat kalıyordu →
   * bayat satırdan ikinci tık API'den 400 alıyordu (veri güvenli, ama kafa karıştırıcı).
   * Ebeveyn paylaşılan bir sayaç tutar: her mutasyonda `onMutated` ile artırır, artan
   * `refreshKey` HER İKİ tabloyu birden yeniden çeker.
   */
  refreshKey?: number;
  onMutated?: () => void;
  /**
   * Hesap ürününün alan şeması — YALNIZ tek ürüne daraltılmış listede anlamlı
   * (ürün detayı). Global listede satırlar farklı ürünlerden gelir → gönderilmez.
   */
  payloadSchema?: PayloadFieldDef[] | null;
  /** Global listede ürün kolonu gösterilir (farklı ürünler karışık gelir). */
  showProductColumn?: boolean;
  /**
   * Başlangıç sayfa boyu. Gömülü kullanımlarda (ör. /stock giriş ekranındaki "Son Eklenen
   * Lisanslar" kartı) 25 satır ekranı gereksiz uzatıyordu — orada 10 verilir, operatör
   * yine de kutudan büyütebilir. Verilmezse liste ekranlarındaki davranış aynen korunur.
   */
  defaultPageSize?: (typeof PAGE_SIZES)[number];
  className?: string;
}) {
  const [search, setSearch] = React.useState('');
  const [term, setTerm] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [holder, setHolder] = React.useState<string>(lockedHolder ?? '');
  const [sort, setSort] = React.useState<string>('created_desc');
  const [pageSize, setPageSize] = React.useState<number>(defaultPageSize ?? 25);
  const [page, setPage] = React.useState(1);
  const [reloadKey, setReloadKey] = React.useState(0);

  const [data, setData] = React.useState<LicenseInventoryPage | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // ── TOPLU SEÇİM ──
  // Yalnız STOKTAKİ (available) kalemler seçilebilir: "geçersiz kıl / hasarlı" satılabilir
  // stoğu düşürme işlemidir; teslim edilmiş bir anahtarı buradan öldürmek müşterinin canlı
  // lisansını sessizce bozardı (o akış sipariş detayındaki "Değiştir").
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [bulkNote, setBulkNote] = React.useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const announce = useAnnouncer();

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
  }, [term, status, holder, sort, pageSize]);

  // Yarışan yanıtlar: yalnız EN SON isteğin sonucu ekrana yazılır (eski yanıt üzerine binmez).
  const reqId = React.useRef(0);
  React.useEffect(() => {
    const id = ++reqId.current;
    let cancelled = false;
    setLoading(true);
    fetchLicenseItemsAction({
      productId,
      batchId,
      status,
      holder: holder || undefined,
      search: term,
      page,
      pageSize,
      sort,
    })
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
  }, [productId, batchId, status, holder, term, page, pageSize, sort, reloadKey, refreshKey]);

  /** Yalnız BU tabloyu tazeler (süzgeç/sayfa değişimi, "Yenile" düğmesi). */
  const reload = React.useCallback(() => setReloadKey((k) => k + 1), []);
  /**
   * VERİYİ DEĞİŞTİREN işlemden sonra: kendini tazele + ebeveyni haberdar et (kardeş tablo
   * da tazelensin). `onMutated` verilmemişse davranış aynen eskisi gibi kalır.
   */
  const reloadAfterMutation = React.useCallback(() => {
    reload();
    onMutated?.();
  }, [reload, onMutated]);

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / (data?.pageSize ?? pageSize)));

  // Kayıt silinince son sayfa boşalabilir → geçerli aralığa çek.
  React.useEffect(() => {
    if (data && page > pageCount) setPage(pageCount);
  }, [data, page, pageCount]);

  const rows = data?.rows ?? [];
  const from = total === 0 ? 0 : (page - 1) * (data?.pageSize ?? pageSize) + 1;
  const to = total === 0 ? 0 : from + rows.length - 1;
  const colCount = (showProductColumn ? 8 : 7) + 1; // +1: seçim kolonu

  // ── Seçim türevleri ──
  const selectableIds = React.useMemo(
    () => rows.filter((r) => r.status === 'available').map((r) => r.id),
    [rows],
  );
  // Seçim SAYFA DEĞİŞİNCE korunur (operatör süzüp birden çok sayfadan toplayabilir) ama
  // seçili bir kalem artık listede yoksa (iptal edildi/atandı) sayaç yanıltmasın diye
  // toplu işlem yalnız GÖRÜNÜR satırların kimliklerini kullanır — id → satır eşlemesi lazım.
  const rowById = React.useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const selectedVisible = React.useMemo(
    () => [...selected].filter((id) => rowById.has(id)),
    [selected, rowById],
  );
  const allVisibleSelected =
    selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const someVisibleSelected = selectableIds.some((id) => selected.has(id));

  const toggleRow = React.useCallback((id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const toggleAllVisible = React.useCallback(
    (on: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of selectableIds) {
          if (on) next.add(id);
          else next.delete(id);
        }
        return next;
      });
    },
    [selectableIds],
  );

  /**
   * Toplu "geçersiz kıl / hasarlı". Seçim farklı ÜRÜNLERE yayılabilir (genel /stock listesi);
   * `/v1/admin/stock-adjustments` ürün-kapsamlı olduğu için istemci ürüne göre gruplar ve
   * grup başına bir istek atar. Sonuç TOPLANIR ve atlananlar dürüstçe raporlanır.
   */
  const runBulk = React.useCallback(
    async (action: 'void' | 'damage') => {
      const ids = selectedVisible.filter((id) => rowById.get(id)?.status === 'available');
      if (ids.length === 0) return;

      const label = action === 'void' ? 'Geçersiz kıl' : 'Hasarlı işaretle';
      const preview = ids
        .slice(0, 8)
        .map((id) => {
          const r = rowById.get(id)!;
          const name = r.kind === 'account'
            ? ((r.fields ?? []).find((f) => !f.secret)?.value ?? 'Hesap kaydı')
            : (r.value ?? 'Anahtar');
          return r.batchCode ? `${name} · ${r.batchCode}` : name;
        });
      if (ids.length > preview.length) preview.push(`… ve ${ids.length - preview.length} kayıt daha`);

      const res = await confirm({
        title: `${ids.length} lisans stoktan düşülecek`,
        description:
          'Bu kalemler "geçersiz" olur; bir daha teslim edilmezler ve Kusurlu Stok ekranında sebebiyle listelenirler. İşlem geri alınamaz.',
        details: preview,
        tone: 'danger',
        confirmLabel: label,
        reason: {
          label: 'Sebep',
          placeholder: 'ör. tedarikçi partisi bozuk — kalemler etkinleşmiyor',
          required: true,
          minLength: 3,
          inputType: 'textarea',
          hint: 'Denetim kaydına ve Kusurlu Stok listesine yazılır.',
        },
      });
      if (!res) return;

      setBulkBusy(true);
      setBulkNote(null);
      try {
        // Ürüne göre grupla (tek ürünlü listede tek grup olur).
        const groups = new Map<string, string[]>();
        for (const id of ids) {
          const pid = rowById.get(id)!.productId;
          groups.set(pid, [...(groups.get(pid) ?? []), id]);
        }
        let affected = 0;
        let skipped = 0;
        const errors: string[] = [];
        for (const [pid, groupIds] of groups) {
          const out = await bulkAdjustLicenseItemsAction({
            productId: pid,
            licenseItemIds: groupIds,
            action,
            reason: res.reason,
          });
          if (out.ok) {
            affected += out.affected;
            skipped += out.skipped;
          } else {
            errors.push(out.error);
          }
        }
        const msg = errors.length
          ? `${affected} lisans düşüldü. Hata: ${errors[0]}`
          : skipped > 0
            ? `${affected} lisans stoktan düşüldü, ${skipped} tanesi atlandı (artık stokta değildi).`
            : `${affected} lisans stoktan düşüldü.`;
        setBulkNote(msg);
        announce(msg);
        setSelected(new Set());
        // Toplu düşme de veriyi DEĞİŞTİRİR → kardeş tablo da tazelenmeli.
        reloadAfterMutation();
      } finally {
        setBulkBusy(false);
      }
    },
    [selectedVisible, rowById, confirm, announce, reloadAfterMutation],
  );

  return (
    <div className={cn('space-y-3', className)}>
      {/*
        ── Üst çubuk: arama + süzgeçler ──
        DAR EKRAN: dört süzgeç `flex-wrap` ile alt alta düşüyordu (etiket+kontrol ≈ 50px ×4
        ≈ 200px, tablo daha başlamadan ekran doluyordu). 360px'te iki sütunlu ızgara → aynı
        süzgeçler ~100px'te sığar; sm ve üstünde eski tek satırlık akış aynen korunur.
      */}
      <div className="grid grid-cols-2 items-end gap-2 sm:flex sm:flex-wrap">
        <div className="col-span-2 flex min-w-56 flex-1 flex-col gap-1">
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
        {/* Kapsam kontrolü yalnız KİLİTLİ DEĞİLKEN gösterilir: kilitli kullanımda
            (parti detayındaki "Müşterilerdeki lisanslar" kartı) kapsamı başlık söyler,
            operatörün onu kazara değiştirip listeyi anlamsızlaştırması istenmez. */}
        {!lockedHolder && (
          <ToolbarSelect
            id={`${uid}-holder`}
            label="Kim tutuyor"
            value={holder}
            onChange={setHolder}
            options={HOLDER_OPTIONS}
          />
        )}
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

      {bulkNote && (
        <Alert variant="success">
          <Check aria-hidden />
          <AlertDescription>{bulkNote}</AlertDescription>
        </Alert>
      )}

      {/* ── Toplu aksiyon çubuğu ──
          Yalnız seçim varken görünür. Bozuk bir tedarikçi partisini tek tek seçiciden
          bulmak yerine listede süzüp (parti/tedarikçi/arama) topluca düşmenin yolu budur. */}
      {selectedVisible.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <span className="text-sm font-medium text-foreground">
            {selectedVisible.length} lisans seçildi
          </span>
          <span className="text-xs text-muted-foreground">
            (yalnız stoktakiler seçilebilir — teslim edilmiş kalem buradan düşülemez)
          </span>
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelected(new Set())}
              disabled={bulkBusy}
            >
              Seçimi temizle
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runBulk('damage')}
              disabled={bulkBusy}
            >
              <ShieldAlert aria-hidden /> Hasarlı işaretle
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => void runBulk('void')}
              disabled={bulkBusy}
            >
              <ShieldAlert aria-hidden /> Geçersiz kıl
            </Button>
          </span>
        </div>
      )}

      {/*
        ── DAR EKRAN: KART LİSTESİ (md altı) ──
        Kullanıcı: "küçük ekranlarda sıkışıyor, yana kaydırma sorunu var, tablolar çok
        yüksek duruyor". ÖLÇÜLDÜ (375px): kolonları gizlemek YETMİYOR — kalan dört kolonun
        min-content genişliği 856px ve kap 291px, yani tablo hâlâ 565px yana kayıyordu
        (anahtar tek parça monospace metin, ürün adı + SKU, iki metin düğmesi).
        5 kolonlu bir tablo 291px'e SIĞMAZ; bu yüzden dar ekranda satır KARTA dönüşür.
        Hücre bileşenleri (LicenseValueCell/StatusCell/DeliveryCell/LicenseItemActions)
        AYNEN yeniden kullanılır → iki ayrı doğruluk kaynağı oluşmaz.
      */}
      <div className="space-y-2 md:hidden" aria-busy={loading}>
        {loading && rows.length === 0 ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={`mc-sk-${i}`} className="rounded-lg border border-border p-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="mt-2 h-3 w-1/3" />
            </div>
          ))
        ) : rows.length === 0 ? null : (
          rows.map((row) => (
            <div
              key={`mc-${row.id}`}
              className={cn(
                'rounded-lg border border-border p-3',
                loading && 'opacity-60',
                selected.has(row.id) && 'bg-accent',
              )}
            >
              <div className="flex items-start gap-2">
                {row.status === 'available' ? (
                  <label className="-m-1 flex size-9 shrink-0 cursor-pointer items-center justify-center">
                    <Checkbox
                      checked={selected.has(row.id)}
                      disabled={bulkBusy}
                      onChange={(e) => toggleRow(row.id, e.currentTarget.checked)}
                      aria-label="Bu lisansı seç"
                    />
                  </label>
                ) : (
                  <span className="size-9 shrink-0" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <LicenseValueCell row={row} />
                  {showProductColumn && (
                    <Link
                      href={`/products/${row.productId}`}
                      className="mt-1 block truncate text-xs font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      {row.productName}
                    </Link>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <StatusCell row={row} />
                    {row.batchCode && <span className="truncate">{row.batchCode}</span>}
                    {row.usageMode === 'multi' && (
                      <span className="tabular-nums">kalan {row.remainingUses}</span>
                    )}
                  </div>
                  {row.delivered && (
                    <div className="mt-1.5">
                      <DeliveryCell row={row} />
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-2 flex justify-end border-t border-border pt-2">
                <LicenseItemActions
                  row={row}
                  payloadSchema={productId ? payloadSchema : undefined}
                  onDone={reloadAfterMutation}
                />
              </div>
            </div>
          ))
        )}
      </div>

      {/* ── Tablo (md ve üstü) ── */}
      <div
        className="hidden rounded-lg border border-border md:block"
        aria-busy={loading}
      >
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {/* Kutunun GÖRSEL boyutu 16px kalır (form kullanımlarıyla tutarlı), dokunma
                  hedefi label sarmalayıcısıyla 44px'e çıkar — toplu seçim ekranın ana işi. */}
              <TableHead className="w-11 p-0">
                <label className="flex size-11 cursor-pointer items-center justify-center">
                  <Checkbox
                    checked={allVisibleSelected}
                    indeterminate={!allVisibleSelected && someVisibleSelected}
                    disabled={selectableIds.length === 0 || bulkBusy}
                    onChange={(e) => toggleAllVisible(e.currentTarget.checked)}
                    aria-label="Bu sayfadaki stoktaki lisansların tümünü seç"
                  />
                </label>
              </TableHead>
              {showProductColumn && <TableHead>Ürün</TableHead>}
              <TableHead>Lisans / Hesap</TableHead>
              <TableHead>Durum</TableHead>
              <TableHead className="hidden lg:table-cell">Kapasite</TableHead>
              <TableHead className="hidden xl:table-cell">Parti</TableHead>
              <TableHead className="hidden md:table-cell">Teslimat</TableHead>
              <TableHead className="hidden lg:table-cell">Eklenme</TableHead>
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
                      // Kilitli kapsamda boş liste bir SONUÇTUR, süzgeç hatası değil:
                      // "bu partiden müşterilerde kalem kalmadı" demektir (hepsi
                      // değiştirilmiş ya da hiç teslim edilmemiş) — öyle de yazar.
                      lockedHolder === 'customer' && !term && !status
                        ? 'Bu partiden müşterilerde kalem kalmadı.'
                        : term || status || holder
                          ? 'Bu süzgeçlerle kayıt bulunamadı.'
                          : productId
                            ? 'Bu ürüne henüz lisans girilmemiş.'
                            : 'Henüz lisans yok.'
                    }
                    description={
                      lockedHolder === 'customer' && !term && !status
                        ? 'Değiştirilecek bir şey yok: bu partinin kalemlerinden hiçbiri şu an bir müşterinin elinde değil.'
                        : term || status || holder
                          ? 'Aramayı veya süzgeçleri değiştirip tekrar deneyin.'
                          : productId
                            ? 'Yukarıdaki “Key / Stok İçe Aktar” bölümünden bu ürüne lisans ekleyebilirsiniz.'
                            : 'Bir ürünün detay sayfasındaki “Key / Stok İçe Aktar” bölümünden lisans ekleyebilirsiniz.'
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={cn('align-top', loading && 'opacity-60')}
                  data-state={selected.has(row.id) ? 'selected' : undefined}
                >
                  {/* p-0 + 44px label: kutu 16px görünür ama dokunma hedefi 44px olur; label'ın
                      merkezi ~22px'e denk geldiği için komşu hücrenin ilk satırıyla hizası korunur. */}
                  <TableCell className="w-11 p-0">
                    {/* Yalnız STOKTAKİ kalem seçilebilir; diğerlerinde kutu hiç basılmaz ki
                        "neden tıklayamıyorum" sorusu doğmasın (disabled kutu da kafa karıştırır). */}
                    {row.status === 'available' ? (
                      <label className="flex size-11 cursor-pointer items-center justify-center">
                        <Checkbox
                          checked={selected.has(row.id)}
                          disabled={bulkBusy}
                          onChange={(e) => toggleRow(row.id, e.currentTarget.checked)}
                          aria-label="Bu lisansı seç"
                        />
                      </label>
                    ) : (
                      <span className="sr-only">Seçilemez — stokta değil</span>
                    )}
                  </TableCell>
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
                    {/*
                      DAR EKRAN ÖZETİ (kullanıcı: "küçük ekranlarda sıkışıyor, yana kaydırma
                      sorunu var"): Kapasite/Parti/Teslimat/Eklenme kolonları md/lg/xl altında
                      GİZLİ — bilgileri kaybolmasın diye burada tek satırda özetlenir. Yalnız
                      DOLU olanlar yazılır; kolonlar görünür olduğunda bu satır kaybolur
                      (aynı bilgiyi iki kez göstermek satırı yine şişirirdi).
                    */}
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground xl:hidden">
                      {row.delivered && (
                        <Link
                          href={`/orders/${row.delivered.orderId}`}
                          className="font-medium tabular-nums text-foreground underline-offset-4 hover:underline md:hidden"
                        >
                          #{row.delivered.remoteOrderId || '—'}
                        </Link>
                      )}
                      {row.batchCode && <span className="truncate">{row.batchCode}</span>}
                      {row.usageMode === 'multi' && (
                        <span className="tabular-nums lg:hidden">
                          kalan {row.remainingUses}
                        </span>
                      )}
                    </div>
                  </TableCell>

                  <TableCell>
                    <StatusCell row={row} />
                  </TableCell>

                  <TableCell className="hidden whitespace-nowrap tabular-nums text-muted-foreground lg:table-cell">
                    {row.usageMode === 'multi' ? (
                      <span title={`${row.useCount} kullanıldı / ${row.maxUses} toplam`}>
                        {row.useCount}/{row.maxUses}
                        <span className="block text-xs">kalan {row.remainingUses}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  <TableCell className="hidden max-w-40 xl:table-cell">
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

                  <TableCell className="hidden max-w-64 md:table-cell">
                    <DeliveryCell row={row} />
                  </TableCell>

                  <TableCell className="hidden whitespace-nowrap tabular-nums text-xs text-muted-foreground lg:table-cell">
                    {fmtDateTime(row.createdAt)}
                  </TableCell>

                  <TableCell className="text-right">
                    <LicenseItemActions
                      row={row}
                      payloadSchema={productId ? payloadSchema : undefined}
                      onDone={reloadAfterMutation}
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

      {/* Onay modali (sebep zorunlu) — toplu geçersiz kılma buradan geçer. */}
      {dialog}
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
 * Durum hücresi — kalemin ham durumu + STOK ÖMRÜ işareti.
 *
 * NEDEN AYRI İŞARET: bir kalem `status='available'` (yani "Stokta") görünürken stok ömrü
 * (`expiresAt`) dolmuş olabilir; API bu kalemi HİÇBİR stok toplamına katmaz ve ATAMAZ. Yalnız
 * "Stokta" yazmak liste ile sayaçları çelişkili gösterir ("stokta görünüyor ama satılmıyor").
 * Ton: satılabilir görünen durumda UYARI (operatör aksiyon almalı — yenile/geçersiz kıl),
 * teslim edilmiş/ölü kayıtta NÖTR (yalnız bilgi, aksiyon gerekmez).
 *
 * Etiketler `lib/labels.ts` tek-kaynağından gelir; ham enum/İngilizce sızmaz.
 */
function StatusCell({ row }: { row: LicenseInventoryRow }) {
  const { expired, expiresAt } = stockExpiry(row);
  // Durumu zaten "Süresi doldu" olan kayıtta ikinci bir işaret gürültüdür.
  const showExpiredFlag = expired && row.status !== 'expired';
  const dateHint = expiresAt
    ? `Stok ömrü ${fmtDateTime(expiresAt)} tarihinde doldu — bu kalem satılamaz/atanamaz.`
    : 'Stok ömrü doldu — bu kalem satılamaz/atanamaz.';

  return (
    <div className="flex flex-col items-start gap-1">
      <StatusBadge status={row.status} />

      {showExpiredFlag &&
        (SELLABLE_STATUS.has(row.status) ? (
          <Badge variant="warning" title={dateHint}>
            <Clock aria-hidden />
            Süresi dolmuş
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground" title={dateHint}>
            süresi dolmuş
          </span>
        ))}

      {/* Henüz dolmamış ömür: FEFO sırasını anlamak için tarih ipucu (sessiz sürpriz olmasın). */}
      {!expired && expiresAt && (
        <span
          className="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
          title="Stok ömrü bitiş tarihi (FEFO: en erken bitecek kalem önce atanır)"
        >
          ömür bitişi {fmtDateTime(expiresAt)}
        </span>
      )}
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
              // Yükseklik ezmesi kaldırıldı (sm = 32px): yanındaki kopyala düğmesi 32px'e
              // çıktığı için ikilinin aynı ölçekte kalması şart.
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
      <CopyButton text={row.value} label="Lisans/hesap değerini kopyala" />
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
        // `size-6` ezmesi kaldırıldı: icon-sm zaten 32px ve dokunma hedefi tabanı bu.
        // 24px'e indirmek yoğun tablo satırında yanlış öğeye basma riski üretiyordu.
        className="shrink-0"
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
            className="inline-flex items-center gap-1 rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
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
