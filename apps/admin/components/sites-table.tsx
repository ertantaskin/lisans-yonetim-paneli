'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, CircleCheck, KeyRound, MoreHorizontal, TriangleAlert, X } from 'lucide-react';
import type { SiteRow } from '../lib/api';
import { fmtDateTime, includesTr, relativeTime } from '../lib/utils';
import { siteTypeLabel } from '../lib/labels';
import { rotateSecretAction, setSiteStatusAction } from '../app/sites/actions';
import { Badge, StatusBadge } from './ui/badge';
import { Button } from './ui/button';
import { useConfirm } from './ui/confirm';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

/**
 * Liste satırı = `SiteRow` + BAĞLANTI SAĞLIĞI alanları.
 *
 * NEDEN ayrı tip: `lib/api.ts` `SiteRow` bu iki kolonu henüz taşımıyor, ama API yanıtında
 * VARLAR (`toPublicSite` sır olmayan tüm kolonları geçirir; 0028). Alanlar OPSİYONEL okunur —
 * api ve admin ayrı imajlar, sürüm sapmasında gelmeyebilir → o durumda "bilinmiyor" gösterilir
 * (uydurma "bağlı" DEĞİL).
 */
export type SiteListRow = SiteRow & {
  /** Sitede kurulu WP eklenti sürümü (imzalı istekteki `x-wpteslimat-version`). */
  pluginVersion?: string | null;
  /** Bu sürümün en son ne zaman bildirildiği (ISO) — sürüm DEĞİŞİNCE yazılır, canlılık ölçmez. */
  pluginVersionAt?: string | null;
  /**
   * Mağazadan gelen SON imzalı isteğin zamanı (ISO; `sites.last_seen_at`, HmacGuard yazar).
   * BAĞLANTININ asıl kanıtı budur — sürüm başlığı yalnız v1.0.0+ WP eklentisinden gelir.
   */
  lastSeenAt?: string | null;
};

/** Bağlantı süzgeci/kolonu için kovalar. */
type ConnectionBucket = 'never' | 'connected' | 'connected-no-version' | 'unknown';

/*
 * KARAR ARTIK `last_seen_at`E DE BAKIYOR.
 *
 * Eskiden yalnız `plugin_version` vardı → sürüm başlığını göndermeyen bir istemci (v1.0.0
 * ÖNCESİ eklenti, marketplace/bayi entegrasyonu) DAKİKALAR ÖNCE imzalı istek atmış olsa bile
 * "hiç bağlanmadı" damgası yiyordu; /sites üstündeki sessizlik bandı ise aynı siteyi "son
 * görülme: az önce" diye gösteriyordu. Çelişen iki cevap operatörü gereksiz rekey'e (çalışan
 * mağazayı kırma riski) itiyordu.
 */
function connectionBucket(site: SiteListRow): ConnectionBucket {
  if (site.pluginVersion) return 'connected';
  if (site.lastSeenAt) return 'connected-no-version';
  // Hiçbir sinyal alanı gelmediyse (eski API) "hiç bağlanmadı" DEME — yanlış alarm olurdu.
  if (
    site.pluginVersion === undefined &&
    site.pluginVersionAt === undefined &&
    site.lastSeenAt === undefined
  ) {
    return 'unknown';
  }
  return 'never';
}

const CONNECTION_LABEL: Record<ConnectionBucket, string> = {
  connected: 'Bağlı',
  'connected-no-version': 'Bağlı (sürüm bilinmiyor)',
  never: 'Hiç bağlanmadı',
  unknown: 'Bilinmiyor',
};

const baseColumns: ColumnDef<SiteListRow>[] = [
  {
    accessorKey: 'domain',
    meta: { title: 'Domain' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Domain" />,
    cell: ({ row }) => (
      <Link
        href={`/sites/${row.original.id}`}
        className="font-medium text-foreground hover:underline"
      >
        {row.original.domain}
      </Link>
    ),
    // TanStack'in yerleşik 'includesString' süzgeci ham `toLowerCase()` kullanır ve
    // Türkçe'de bozuktur (İ/I) → Türkçe-duyarlı karşılaştırma. Domain'de IDN/Türkçe
    // karakter bulunabildiği için burada da geçerli.
    filterFn: (row, _id, value) => includesTr(row.original.domain, value),
  },
  {
    accessorKey: 'type',
    meta: { title: 'Tip' },
    header: 'Tip',
    cell: ({ row }) => <span className="text-muted-foreground">{siteTypeLabel(row.original.type)}</span>,
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'senderEmail',
    meta: { title: 'Gönderen' },
    header: 'Gönderen',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.senderEmail ?? '—'}</span>,
  },
  {
    accessorKey: 'status',
    meta: { title: 'Durum' },
    header: 'Durum',
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    // 'Durum' rozeti YALNIZ "askıya alınmadı" demektir: eklentisi hiç kurulmamış bir site de
    // 'aktif' görünür. Operatörün ilk sorusu ("hangi mağaza gerçekten bağlı?") bu kolonda
    // yanıtlanır — kanıt, sitenin imzalı isteğinde bildirdiği eklenti sürümüdür (0028).
    id: 'connection',
    accessorFn: (row) => connectionBucket(row),
    meta: { title: 'Bağlantı' },
    header: 'Bağlantı',
    cell: ({ row }) => {
      const site = row.original;
      const bucket = connectionBucket(site);
      if (bucket === 'unknown') {
        return <span className="text-muted-foreground">—</span>;
      }
      if (bucket === 'never') {
        return (
          <Badge variant="warning">
            <TriangleAlert />
            hiç bağlanmadı
          </Badge>
        );
      }
      if (bucket === 'connected-no-version') {
        // Bağlantı VAR (imzalı istek geldi) ama istemci sürüm başlığı göndermiyor → uyarı
        // TONU KULLANILMAZ: bu bir arıza değil, yalnız eksik telemetridir.
        const seen = site.lastSeenAt ?? null;
        const seenRel = seen ? relativeTime(seen) : null;
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge variant="neutral">sürüm bilinmiyor</Badge>
            {seen && seenRel && (
              <span className="text-xs text-muted-foreground" title={fmtDateTime(seen)}>
                {seenRel === 'az önce' ? seenRel : `${seenRel} önce`}
              </span>
            )}
          </span>
        );
      }
      const at = site.pluginVersionAt ?? null;
      // relativeTime 'az önce' de dönebilir → "az önce önce" yazmamak için ayrı ele alınır.
      const rel = at ? relativeTime(at) : null;
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant="success">v{site.pluginVersion}</Badge>
          {at && rel && (
            <span className="text-xs text-muted-foreground" title={fmtDateTime(at)}>
              {rel === 'az önce' ? rel : `${rel} önce`}
            </span>
          )}
        </span>
      );
    },
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
];

/** Rotasyon başarısında bir kez gösterilecek secret bilgisi. */
type RotatedNotice = { domain: string; hmacSecret: string };

/**
 * Owner-olmayan operatöre gösterilecek gerekçe (§8 RBAC).
 *
 * NEDEN GÖRÜNÜR BİR GEREKÇE: iki aksiyon da sunucuda `isOwner()` ile korunuyor ve API'de
 * `OwnerGuard` var (veri güvende) — ama düğme AÇIK sunuluyordu. Operatör onay modalini geçip
 * ("Yenile" / "Askıya al") ancak SONRA "yetkiniz yok" alıyordu. Proje kuralı: tıklanıp hata
 * veren düğme, hiç sunulmayandan kötüdür (bkz. inventory/license-item-actions.tsx).
 */
const OWNER_ONLY_REASON =
  'Bu işlem yalnız Sahip (owner) rolündeki yöneticiler içindir — mağazanın kimlik bilgilerini ve sipariş kabulünü etkiler.';

/** Site satır aksiyonları — şu an: HMAC secret yenile (confirm + loglu). */
function SiteRowActions({
  site,
  canOwner,
  onRotated,
  onError,
}: {
  site: SiteListRow;
  /** Oturum owner mı (sunucudan SERİLEŞTİRİLEBİLİR boolean olarak gelir — fonksiyon prop'u YOK). */
  canOwner: boolean;
  onRotated: (notice: RotatedNotice) => void;
  onError: (message: string) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const { confirm, dialog } = useConfirm();
  const suspended = site.status === 'suspended';

  const rotate = async () => {
    const ok = await confirm({
      title: `${site.domain} için HMAC secret yenilensin mi?`,
      description:
        'Eski secret 24 saat daha geçerli kalır (eklenti kesintisiz yeni secret’a geçer). Yeni secret yalnız BİR KEZ gösterilir — kaydetmezseniz tekrar göremezsiniz.',
      confirmLabel: 'Yenile',
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await rotateSecretAction(site.id);
      if (res.ok && res.hmacSecret) onRotated({ domain: site.domain, hmacSecret: res.hmacSecret });
      else onError(res.error ?? 'Secret yenilenemedi');
    });
  };

  const toggleStatus = async () => {
    const next = suspended ? 'active' : 'suspended';
    const ok = await confirm(
      suspended
        ? {
            title: `${site.domain} yeniden aktifleştirilsin mi?`,
            description: 'Yeni sipariş push kabulü tekrar açılır.',
            confirmLabel: 'Aktifleştir',
          }
        : {
            title: `${site.domain} askıya alınsın mı?`,
            description:
              'Askıdayken HMAC kimlik doğrulaması reddedilir — mağaza yeni sipariş gönderemez. İşlem geri alınabilir.',
            tone: 'danger',
            confirmLabel: 'Askıya al',
          },
    );
    if (!ok) return;
    startTransition(async () => {
      const res = await setSiteStatusAction(site.id, next);
      if (!res.ok) onError(res.error ?? 'Durum değiştirilemedi');
    });
  };

  return (
    <>
    {dialog}
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={pending}
          title="Aksiyonlar"
          aria-label={`${site.domain} aksiyonları`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => void rotate()}
          disabled={pending || !canOwner}
          title={canOwner ? undefined : OWNER_ONLY_REASON}
        >
          <KeyRound />
          {pending ? 'Yenileniyor…' : 'Secret Yenile'}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void toggleStatus()}
          disabled={pending || !canOwner}
          title={canOwner ? undefined : OWNER_ONLY_REASON}
        >
          {suspended ? <CircleCheck /> : <Ban />}
          {suspended ? 'Aktifleştir' : 'Askıya Al'}
        </DropdownMenuItem>
        {/* Gerekçe GÖRÜNÜR olmalı: devre dışı menü öğesinin tooltip'i her tarayıcıda/klavyede
            açılmaz — operatör düğmenin neden kapalı olduğunu tahmin etmek zorunda kalmasın
            (dead-letter-table.tsx'teki aynı desen). */}
        {!canOwner && (
          <p className="max-w-56 px-2 py-1.5 text-xs text-muted-foreground">{OWNER_ONLY_REASON}</p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}

export function SitesTable({
  sites,
  canOwner = true,
}: {
  sites: SiteListRow[];
  /**
   * Oturum owner mı (§8). Varsayılan `true` — auth KAPALI kurulumda panel zaten herkese
   * açıktır ve `isOwner()` de true döner; ayrıca prop'u geçmeyi unutan bir çağıran
   * aksiyonları sessizce kilitlemez (asıl kapı sunucudaki isOwner() + API OwnerGuard).
   */
  canOwner?: boolean;
}) {
  const [rotated, setRotated] = React.useState<RotatedNotice | null>(null);
  const [rotateError, setRotateError] = React.useState<string | null>(null);

  const handleRotated = React.useCallback((notice: RotatedNotice) => {
    setRotateError(null);
    setRotated(notice);
  }, []);
  const handleError = React.useCallback((message: string) => {
    setRotated(null);
    setRotateError(message);
  }, []);

  const columns = React.useMemo<ColumnDef<SiteListRow>[]>(
    () => [
      ...baseColumns,
      {
        id: 'actions',
        header: () => <span className="sr-only">Aksiyonlar</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <SiteRowActions
              site={row.original}
              canOwner={canOwner}
              onRotated={handleRotated}
              onError={handleError}
            />
          </div>
        ),
        enableSorting: false,
        enableHiding: false,
      },
    ],
    [handleRotated, handleError, canOwner],
  );

  const facets: FacetConfig[] = React.useMemo(() => {
    const list: FacetConfig[] = [];
    const types = Array.from(new Set(sites.map((s) => s.type))).sort();
    if (types.length > 1) {
      list.push({
        columnId: 'type',
        title: 'Tip',
        options: types.map((t) => ({ label: siteTypeLabel(t), value: t })),
      });
    }
    // Bağlantı süzgeci yalnız VERİDE gerçekten bulunan kovalarla üretilir → "sistemde yalnız
    // bu durumlar var" izlenimi doğru kalır (boş kova seçeneği sunulmaz).
    const buckets = Array.from(new Set(sites.map(connectionBucket)));
    if (buckets.length > 1) {
      list.push({
        columnId: 'connection',
        title: 'Bağlantı',
        options: buckets.map((b) => ({ label: CONNECTION_LABEL[b], value: b })),
      });
    }
    return list;
  }, [sites]);

  return (
    <div className="space-y-4">
      {rotated && (
        <Alert variant="warning">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>Yeni HMAC secret yalnız bir kez gösterilir — güvenli saklayın</AlertTitle>
            <AlertDescription>
              <div className="mb-1.5 text-foreground/70">
                {rotated.domain} · eski secret 24 saat daha geçerli
              </div>
              <div className="break-all font-mono text-xs text-foreground">
                <span className="text-foreground/70">HMAC Secret:</span> {rotated.hmacSecret}
              </div>
            </AlertDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setRotated(null)}
            aria-label="Kapat"
            className="-mr-1 -mt-1 shrink-0"
          >
            <X />
          </Button>
        </Alert>
      )}
      {rotateError && (
        <Alert variant="destructive">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>Secret yenilenemedi</AlertTitle>
            <AlertDescription>{rotateError}</AlertDescription>
          </div>
        </Alert>
      )}

      <DataTable
        columns={columns}
        data={sites}
        searchColumnId="domain"
        searchPlaceholder="Domain ara…"
        facets={facets}
        initialSorting={[{ id: 'domain', desc: false }]}
        emptyLabel="Henüz site yok."
      />
    </div>
  );
}
