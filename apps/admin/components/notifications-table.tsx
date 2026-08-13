'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import {
  AlertTriangle,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  CheckCircle2,
  Info,
  MailWarning,
  PackageX,
  RefreshCw,
  Send,
  ShieldAlert,
  TimerOff,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { NotificationRow } from '../app/notifications/queries';
import { fmtDateTime, includesTr } from '../lib/utils';
import { notificationTypeLabel, severityLabel } from '../lib/labels';
import { checkLowStockAction } from '../app/notifications/actions';
import { useLive } from './live/live-provider';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { useConfirm } from './ui/confirm';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

// ── Seviye → rozet varyant + ikon (etiket labels.ts severityLabel'dan — TEK KAYNAK) ──
const SEVERITY: Record<string, { variant: 'danger' | 'warning' | 'neutral'; icon: typeof Info }> = {
  critical: { variant: 'danger', icon: ShieldAlert },
  warning: { variant: 'warning', icon: AlertTriangle },
  info: { variant: 'neutral', icon: Info },
};

/**
 * Okuma durumu — `readAt` (timestamp) alanından TÜRETİLEN UI durumu; backend enum'u DEĞİLDİR,
 * bu yüzden etiketi labels.ts'te değil burada durur (ham 'read'/'unread' hiçbir yerde
 * kullanıcıya gösterilmez; yalnız süzgeç değeri olarak taşınır).
 */
const READ_STATE = {
  unread: 'Okunmamış',
  read: 'Okundu',
} as const;

type ReadState = keyof typeof READ_STATE;

const readState = (n: NotificationRow): ReadState => (n.readAt ? 'read' : 'unread');

/**
 * Bu ekrana ÖZEL yerel tür sözlüğü. `notificationTypeLabel` (labels.ts) bu iki türü henüz
 * tanımıyor ve bilinmeyen anahtarda HAM değeri döndürüyor → operatöre en KRİTİK iki alarm
 * `mail_config` / `sweep_failed` diye ham İngilizce çıkıyordu. Öncelik: labels.ts biliyorsa o
 * kazanır (tek kaynak korunur; sözlüğe eklenirse burası kendiliğinden devre dışı kalır).
 */
const LOCAL_TYPE: Record<string, string> = {
  mail_config: 'Mail yapılandırması',
  sweep_failed: 'Bakım işi başarısız',
};

function typeLabel(type: string): string {
  const known = notificationTypeLabel(type);
  return known !== type ? known : (LOCAL_TYPE[type] ?? type);
}

/** UUID (v4 dahil, gevşek) — meta'dan gelen id ancak doğrulandıktan sonra bağlantıya çevrilir. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Bildirimin hedef ÜRÜNÜ (varsa). `low_stock` bildirimi ürün id'sini meta'sında taşır ama
 * satırda bağlantı yoktu → operatör alarmı görüp SKU'yu elle kopyalayarak ürünü arıyordu.
 * Doğrulanmamış/uydurma değerle link üretilmez (UUID değilse null).
 */
function productIdOf(n: NotificationRow): string | null {
  const raw = n.meta?.productId;
  return typeof raw === 'string' && UUID_RE.test(raw) ? raw : null;
}

function SeverityBadge({ severity }: { severity: string }) {
  const meta = SEVERITY[severity] ?? { variant: 'neutral' as const, icon: Info };
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant}>
      <Icon />
      {severityLabel(severity)}
    </Badge>
  );
}

/**
 * Kolonlar — "okundu işaretle" aksiyonu satırdan çağrıldığı için bileşen içinde kurulur
 * (modül seviyesinde sabit olamaz).
 */
function buildColumns(
  onMarkRead: (ids: string[]) => void,
  busy: boolean,
): ColumnDef<NotificationRow>[] {
  return [
    {
      id: 'readState',
      accessorFn: (r) => readState(r),
      meta: { title: 'Okuma durumu' },
      header: 'Okuma durumu',
      enableSorting: false,
      cell: ({ row }) => {
        const n = row.original;
        return n.readAt ? (
          <span
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            title={`Okundu: ${fmtDateTime(n.readAt)}`}
          >
            <Check className="size-3" aria-hidden />
            {READ_STATE.read}
          </span>
        ) : (
          <Badge variant="warning">
            <Bell />
            {READ_STATE.unread}
          </Badge>
        );
      },
      filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
    },
    {
      accessorKey: 'severity',
      meta: { title: 'Seviye' },
      header: 'Seviye',
      cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
      filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
    },
    {
      accessorKey: 'type',
      meta: { title: 'Tür' },
      header: 'Tür',
      cell: ({ row }) => <Badge variant="outline">{typeLabel(row.original.type)}</Badge>,
      filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
    },
    {
      accessorKey: 'title',
      meta: { title: 'Bildirim' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Bildirim" />,
      cell: ({ row }) => {
        const unread = !row.original.readAt;
        const productId = productIdOf(row.original);
        return (
          <div className="max-w-md">
            {/*
              Okunmamış satır VURGULANIR (kalın başlık + "Okunmamış" rozeti). Satırın TAMAMINA
              zemin verilemiyor: DataTable satır sınıfı için kanca sunmuyor (paylaşılan bileşen).
              Renk zaten tek başına bilgi taşımıyor — durum metinle de yazılı (WCAG 1.4.1).
            */}
            <div className={unread ? 'font-semibold text-foreground' : 'font-medium text-foreground'}>
              {/* Alarmın gerektirdiği EYLEM ile ekran arasındaki yol: ürün bilinen bildirimlerde
                  (ör. düşük stok) başlık doğrudan ürün detayına gider. */}
              {productId ? (
                <Link
                  href={`/products/${productId}`}
                  className="text-primary underline-offset-2 hover:underline"
                  title="Ürün detayına git (stok girişi)"
                >
                  {row.original.title}
                </Link>
              ) : (
                row.original.title
              )}
            </div>
            <div className="line-clamp-2 max-w-md whitespace-normal text-muted-foreground" title={row.original.message}>
              {row.original.message}
            </div>
          </div>
        );
      },
      // Arama: başlık VEYA mesaj. Türkçe-duyarlı karşılaştırma (`includesTr`): ham
      // `toLowerCase()` "İ"/"I" içeren başlık/mesajlarda sessizce eşleşmiyordu.
      filterFn: (row, _id, value) =>
        includesTr(row.original.title, value) || includesTr(row.original.message, value),
    },
    {
      accessorKey: 'sentTelegram',
      meta: { title: 'Telegram' },
      header: 'Telegram',
      cell: ({ row }) =>
        row.original.sentTelegram ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-success">
            <Send className="size-3" /> gönderildi
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
      enableSorting: false,
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
      meta: { title: 'İşlem' },
      header: '',
      enableSorting: false,
      enableHiding: false,
      cell: ({ row }) =>
        row.original.readAt ? null : (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onMarkRead([row.original.id])}
            title="Bu bildirimi okundu işaretle"
          >
            <Check />
            Okundu işaretle
          </Button>
        ),
    },
  ];
}

const facets: FacetConfig[] = [
  {
    columnId: 'readState',
    title: 'Okuma durumu',
    options: [
      { label: READ_STATE.unread, value: 'unread', icon: Bell },
      { label: READ_STATE.read, value: 'read', icon: BellOff },
    ],
  },
  {
    columnId: 'severity',
    title: 'Seviye',
    options: [
      { label: severityLabel('critical'), value: 'critical', icon: ShieldAlert },
      { label: severityLabel('warning'), value: 'warning', icon: AlertTriangle },
      { label: severityLabel('info'), value: 'info', icon: Info },
    ],
  },
  {
    columnId: 'type',
    title: 'Tür',
    // KRİTİK iki tür (mail_config = mailler müşteriye ULAŞMIYOR, sweep_failed = bakım işi çöktü)
    // süzgeçte YOKTU → operatör en önemli alarmları türe göre süzemiyordu.
    options: [
      { label: typeLabel('low_stock'), value: 'low_stock', icon: PackageX },
      { label: typeLabel('mail_config'), value: 'mail_config', icon: MailWarning },
      { label: typeLabel('sweep_failed'), value: 'sweep_failed', icon: TimerOff },
      { label: typeLabel('digest_alert'), value: 'digest_alert', icon: Bell },
      {
        label: typeLabel('reconcile_violation'),
        value: 'reconcile_violation',
        icon: ShieldAlert,
      },
    ],
  },
];

/** Düşük stok kontrolünü elle çalıştırır; sonuç/hata mesajı yüzeye çıkar. */
function LowStockCheckButton({
  onResult,
}: {
  onResult: (r: { ok: boolean; created?: number; error?: string }) => void;
}) {
  const [pending, startTransition] = React.useTransition();

  const run = () => {
    startTransition(async () => {
      const res = await checkLowStockAction();
      onResult(res);
    });
  };

  return (
    <Button variant="outline" size="sm" onClick={run} disabled={pending}>
      <RefreshCw className={pending ? 'animate-spin' : undefined} />
      {pending ? 'Kontrol ediliyor…' : 'Düşük stok kontrolü çalıştır'}
    </Button>
  );
}

export function NotificationsTable({
  notifications,
  truncated = false,
  limit,
}: {
  notifications: NotificationRow[];
  /** Liste API üst sınırına dayandı → daha eski bildirimler burada YOK. */
  truncated?: boolean;
  limit?: number;
}) {
  const router = useRouter();
  // Üst bardaki çan ile AYNI veriye bakar: okundu işaretlendikten sonra rozeti de tazeleriz
  // (aksi halde ekran "okundu" der, çan hâlâ "3 yeni" gösterirdi — kopukluk buydu).
  const { data: live, refresh: refreshLive } = useLive();
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [marking, startMarking] = React.useTransition();
  const { confirm, dialog } = useConfirm();

  const rows = React.useMemo(() => notifications ?? [], [notifications]);
  const localUnread = React.useMemo(() => rows.filter((n) => !n.readAt).length, [rows]);
  // Çan sayacı TÜM okunmamışları bilir (liste yalnız son N kaydı taşır); veri gelmediyse 0 olur.
  const globalUnread = live.notifications.unread;
  const hasUnread = localUnread > 0 || globalUnread > 0;

  const handleResult = React.useCallback(
    (r: { ok: boolean; created?: number; error?: string }) => {
      if (r.ok) {
        setError(null);
        setSuccess(
          r.created && r.created > 0
            ? `${r.created} yeni düşük stok bildirimi üretildi.`
            : 'Kontrol tamamlandı — yeni bildirim yok.',
        );
      } else {
        setSuccess(null);
        setError(r.error ?? 'Kontrol çalıştırılamadı');
      }
    },
    [],
  );

  /**
   * Okundu işaretle. `ids` verilmezse TÜM okunmamışlar (listede görünmeyenler dahil) —
   * backend `{all:true}` semantiği budur, bu yüzden toplu aksiyon onay ister.
   * Sonuç DÜRÜST raporlanır: sunucu `marked=0` derse "başarılı" denmez.
   */
  const markRead = React.useCallback(
    (ids?: string[]) => {
      startMarking(async () => {
        try {
          const res = await fetch('/api/notifications/read', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(ids?.length ? { ids } : { all: true }),
          });
          const body = (await res.json().catch(() => null)) as { marked?: number } | null;
          if (!res.ok) throw new Error(`Okundu işaretlenemedi (sunucu ${res.status})`);
          const marked = typeof body?.marked === 'number' ? body.marked : 0;
          setError(null);
          setSuccess(
            marked > 0
              ? `${marked} bildirim okundu işaretlendi.`
              : 'Bildirim zaten okunmuştu — değişiklik yapılmadı.',
          );
          refreshLive(); // üst bardaki çan rozeti
          router.refresh(); // sunucu-render liste
        } catch (e) {
          setSuccess(null);
          setError(e instanceof Error ? e.message : 'Okundu işaretlenemedi');
        }
      });
    },
    [refreshLive, router],
  );

  const markAll = async () => {
    const ok = await confirm({
      title: 'Tümü okundu işaretlensin mi?',
      description:
        'Bu listede görünmeyen ESKİ bildirimler de dahil, tüm okunmamış bildirimler okundu sayılır. Geri alınamaz.',
      confirmLabel: 'Tümünü okundu yap',
    });
    if (!ok) return;
    markRead();
  };

  const columns = React.useMemo(() => buildColumns((ids) => markRead(ids), marking), [
    markRead,
    marking,
  ]);

  return (
    <div className="space-y-4">
      {dialog}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void markAll()}
          disabled={marking || !hasUnread}
          title={
            hasUnread
              ? 'Listede görünmeyenler dahil tüm okunmamış bildirimleri okundu işaretler'
              : 'Okunmamış bildirim yok'
          }
        >
          <CheckCheck />
          {marking ? 'İşaretleniyor…' : 'Tümünü okundu işaretle'}
        </Button>
        <LowStockCheckButton onResult={handleResult} />
      </div>

      {truncated && (
        <Alert variant="info">
          <Info />
          <div className="min-w-0 flex-1">
            <AlertDescription>
              Yalnız en son {limit ?? rows.length} bildirim gösteriliyor — daha eskiler bu listede
              yok. Okunmamışları eritmek için “Tümünü okundu işaretle” listede görünmeyenleri de
              kapsar.
            </AlertDescription>
          </div>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>İşlem tamamlanamadı</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setError(null)}
            aria-label="Kapat"
            className="-mr-1 -mt-1 shrink-0"
          >
            <X />
          </Button>
        </Alert>
      )}

      {success && (
        <Alert variant="success">
          <CheckCircle2 />
          <div className="min-w-0 flex-1">
            <AlertTitle>İşlem tamamlandı</AlertTitle>
            <AlertDescription>{success}</AlertDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSuccess(null)}
            aria-label="Kapat"
            className="-mr-1 -mt-1 shrink-0"
          >
            <X />
          </Button>
        </Alert>
      )}

      <DataTable
        columns={columns}
        data={rows}
        searchColumnId="title"
        searchPlaceholder="Başlık veya mesaj…"
        facets={facets}
        initialSorting={[{ id: 'createdAt', desc: true }]}
        emptyLabel="Bildirim yok."
      />
    </div>
  );
}
