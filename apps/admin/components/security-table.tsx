'use client';
import * as React from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Activity,
  Ban,
  CheckCircle2,
  Gauge,
  Info,
  KeyRound,
  LogIn,
  RadioTower,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  TriangleAlert,
  UserCheck,
  UserMinus,
  UserPlus,
  UserX,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { SecurityEventRow } from '../app/security/queries';
import { fmtDateTime } from '../lib/utils';
import { securityTypeLabel, severityLabel } from '../lib/labels';
import { scanSecurityAction, anonymizeCustomerAction } from '../app/security/actions';
import { Badge, type BadgeProps } from './ui/badge';
import { Button } from './ui/button';
import { useConfirm } from './ui/confirm';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Card } from './ui/card';
import { Input, Label } from './ui/input';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

// ── Tip → ikon (etiket labels.ts securityTypeLabel'dan gelir — TEK KAYNAK) ────
// LucideIcon: facet seçenekleri (FacetOption.icon) de aynı ikonları kullanır → tek tip.
const TYPE_ICON: Record<string, LucideIcon> = {
  velocity: RadioTower,
  quota_exceeded: Gauge,
  quota_review: Gauge,
  anomaly: Activity,
  blocklist: Ban,
  // Yönetici hesap/oturum yaşam döngüsü (admin-users.service).
  admin_login: LogIn,
  admin_login_failed: KeyRound,
  admin_created: UserPlus,
  admin_disabled: UserMinus,
  admin_reactivated: UserCheck,
  admin_password_reset: KeyRound,
  admin_removed: UserX,
  // İki faktörlü giriş (§8).
  admin_totp_setup_started: ShieldCheck,
  admin_totp_enabled: ShieldCheck,
  admin_totp_disabled: ShieldX,
  admin_totp_reset: KeyRound,
  admin_totp_failed: KeyRound,
};

// Etiketler TEK KAYNAK `labels.ts` → burada yerel sözlük YOK (bir dönem vardı; aynı ekranda
// iki sözlük tutmak bu projede çelişen etiket üretmişti).
const typeLabel = securityTypeLabel;

// ── Severity → rozet varyant + ikon (etiket labels.ts severityLabel'dan) ──────
const SEVERITY_META: Record<
  string,
  { variant: NonNullable<BadgeProps['variant']>; icon: React.ComponentType<{ className?: string }> }
> = {
  info: { variant: 'outline', icon: Info },
  warning: { variant: 'warning', icon: TriangleAlert },
  critical: { variant: 'danger', icon: ShieldAlert },
};

function TypeCell({ type }: { type: string }) {
  const Icon = TYPE_ICON[type] ?? ShieldAlert;
  return (
    <span className="inline-flex items-center gap-1.5 text-foreground">
      <Icon className="size-3.5 text-muted-foreground" />
      {typeLabel(type)}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const meta = SEVERITY_META[severity] ?? { variant: 'neutral' as const, icon: Info };
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant}>
      <Icon />
      {severityLabel(severity)}
    </Badge>
  );
}

const columns: ColumnDef<SecurityEventRow>[] = [
  {
    accessorKey: 'type',
    meta: { title: 'Tür' },
    header: 'Tür',
    cell: ({ row }) => <TypeCell type={row.original.type} />,
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'severity',
    meta: { title: 'Önem' },
    header: 'Önem',
    cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'subject',
    meta: { title: 'Özne' },
    header: 'Özne',
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.subject ?? '—'}</span>
    ),
    enableSorting: false,
  },
  {
    accessorKey: 'detail',
    meta: { title: 'Detay' },
    header: 'Detay',
    cell: ({ row }) => (
      <span className="line-clamp-2 max-w-md whitespace-normal text-muted-foreground" title={row.original.detail}>
        {row.original.detail}
      </span>
    ),
    enableSorting: false,
  },
  {
    accessorKey: 'siteDomain',
    meta: { title: 'Site' },
    header: 'Site',
    cell: ({ row }) => {
      const { siteDomain, siteId } = row.original;
      // Domain varsa alan adı; site'lı ama domain gelmediyse '—'; site'sız (global) olay → 'sistem'.
      const label = siteDomain ?? (siteId ? '—' : 'sistem');
      return <span className="text-xs text-muted-foreground">{label}</span>;
    },
    enableSorting: false,
  },
  {
    accessorKey: 'createdAt',
    meta: { title: 'Zaman' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Zaman" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {fmtDateTime(row.original.createdAt)}
      </span>
    ),
    sortingFn: 'datetime',
  },
];

/**
 * Süzgeçte GÖRÜNEN türler. Yönetici auth olayları (özellikle `admin_login_failed` = brute-force
 * sinyali) buraya EKLENDİ: eskiden liste yalnız 5 eski türü sayıyordu → en kritik güvenlik
 * sinyali süzülemiyor, üstelik süzgeç "sistemde yalnız bu türler var" izlenimi veriyordu.
 */
const TYPE_FACET_VALUES = [
  'admin_login_failed',
  'admin_totp_failed',
  'admin_login',
  'admin_created',
  'admin_disabled',
  'admin_reactivated',
  'admin_password_reset',
  'admin_removed',
  'admin_totp_enabled',
  'admin_totp_disabled',
  'admin_totp_reset',
  'velocity',
  'quota_exceeded',
  'quota_review',
  'anomaly',
  'blocklist',
] as const;

const facets: FacetConfig[] = [
  {
    columnId: 'type',
    title: 'Tür',
    options: TYPE_FACET_VALUES.map((v) => ({
      label: typeLabel(v),
      value: v,
      icon: TYPE_ICON[v] ?? ShieldAlert,
    })),
  },
  {
    columnId: 'severity',
    title: 'Önem',
    options: [
      { label: severityLabel('info'), value: 'info', icon: Info },
      { label: severityLabel('warning'), value: 'warning', icon: TriangleAlert },
      { label: severityLabel('critical'), value: 'critical', icon: ShieldAlert },
    ],
  },
];

/** Elle tarama tetikleyici — POST /v1/admin/security/scan. */
function ScanButton({ onError, onDone }: { onError: (m: string) => void; onDone: (n: number) => void }) {
  const [pending, startTransition] = React.useTransition();
  const scan = () => {
    startTransition(async () => {
      const res = await scanSecurityAction();
      if (res.ok) onDone(res.created ?? 0);
      else onError(res.error ?? 'Tarama başarısız');
    });
  };
  return (
    <Button variant="outline" size="sm" onClick={scan} disabled={pending}>
      <ScanSearch />
      {pending ? 'Taranıyor…' : 'Tara'}
    </Button>
  );
}

/**
 * KVKK anonimleştirme formu — TEK YÖNLÜ, confirm + audit uyarısı.
 *
 * RBAC (§8/§9): aksiyon sunucuda `isOwner()` ile korunuyor ama form HERKESE açıktı — bu, bu
 * paneldeki en kötü "tıklanıp hata veren düğme" senaryosuydu: owner-olmayan operatör
 * e-postayı yazıyor, kırmızı "TEK YÖNLÜ… GERİ ALINAMAZ" onayını geçiyor ve ANCAK SONRA
 * "yetkiniz yok" alıyordu (geri alınamaz bir işlemi onayladığını sanarak). Owner değilse
 * form hiç RENDER EDİLMEZ; yerine ne yapılacağını söyleyen bir not durur (/sites/new deseni).
 */
function AnonymizeForm({
  canOwner,
  onError,
  onDone,
}: {
  /** Oturum owner mı — SUNUCUDAN serileştirilebilir boolean olarak gelir (fonksiyon prop'u YOK). */
  canOwner: boolean;
  onError: (m: string) => void;
  onDone: (orders: number, replacements: number) => void;
}) {
  const [email, setEmail] = React.useState('');
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const { confirm, dialog } = useConfirm();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setLocalError('E-posta zorunlu');
      return;
    }
    setLocalError(null);
    const ok = await confirm({
      title: `${trimmed} anonimleştirilsin mi?`,
      description:
        'TEK YÖNLÜ işlem (KVKK): bu e-postanın kişisel verisi tüm siparişlerde ve değişim taleplerinde maskelenir, müşteri kaydı silinir. Sipariş/atama bütünlüğü korunur. GERİ ALINAMAZ ve denetim kaydına yazılır.',
      tone: 'danger',
      confirmLabel: 'Anonimleştir',
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await anonymizeCustomerAction(trimmed);
      if (res.ok) {
        setEmail('');
        onDone(res.anonymizedOrders ?? 0, res.anonymizedReplacements ?? 0);
      } else {
        onError(res.error ?? 'Anonimleştirme başarısız');
      }
    });
  };

  // Hook'lar KOŞULSUZ çağrıldıktan SONRA dallan (React kuralı): owner değilse form yerine
  // gerekçe. Bölüm tamamen gizlenmez — yeteneğin var olduğunu ama kimin kullanabileceğini
  // bilmek operatörün doğru kişiye yönlenmesini sağlar.
  if (!canOwner) {
    return (
      <Card className="p-5">
        <div className="mb-1 flex items-center gap-2">
          <UserX className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">KVKK anonimleştirme</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Bu işlem TEK YÖNLÜdür ve geri alınamaz; yalnız Sahip (owner) rolündeki yöneticiler
          çalıştırabilir. Bir müşterinin kişisel verisinin silinmesi gerekiyorsa Sahip rolündeki
          yöneticiye başvurun.
        </p>
      </Card>
    );
  }

  return (
    // Card primitifi (elle kopyalanan sınıf dizisi shadow-xs'i düşürüyordu; tema değişince
    // ad-hoc kopya geride kalır). Dolgu p-5 korunur — CardContent'in üst dolgusu yok, başlık yapışır.
    <Card className="p-5">
      {dialog}
      <div className="mb-1 flex items-center gap-2">
        <UserX className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">KVKK anonimleştirme</h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Verilen e-postanın kişisel verisi tüm kayıtlarda maskelenir (tek yönlü). Sipariş/atama
        bütünlüğü korunur; işlem denetim kaydına düşer.
      </p>
      <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="anon-email">Müşteri e-postası</Label>
          <Input
            id="anon-email"
            type="email"
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
            placeholder="musteri@ornek.com"
            className="w-64"
          />
          {localError && <p className="text-xs text-destructive">{localError}</p>}
        </div>
        {/* size="sm" (h-8/12px) KALDIRILDI: yanındaki Input h-9/14px — aynı form satırında
            iki farklı ölçek taban çizgisini bozuyordu (panel deseni: gönder düğmesi varsayılan boyut). */}
        <Button type="submit" variant="danger" disabled={pending}>
          <ShieldX />
          {pending ? 'İşleniyor…' : 'Anonimleştir'}
        </Button>
      </form>
    </Card>
  );
}

/** Kapatılabilir bildirim (başarı/hata) satırı. */
function Notice({
  variant,
  title,
  message,
  onClose,
}: {
  variant: 'success' | 'destructive';
  title: string;
  message: string;
  onClose: () => void;
}) {
  return (
    <Alert variant={variant}>
      {variant === 'success' ? <CheckCircle2 /> : <TriangleAlert />}
      <div className="min-w-0 flex-1">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onClose}
        aria-label="Kapat"
        className="-mr-1 -mt-1 shrink-0"
      >
        <X />
      </Button>
    </Alert>
  );
}

export function SecurityTable({
  events,
  truncated = false,
  limit,
  canOwner = true,
}: {
  events: SecurityEventRow[];
  /** API üst sınırına dayanıldı → daha eski olaylar bu listede YOK (sessiz kırpma olmasın). */
  truncated?: boolean;
  limit?: number;
  /**
   * Oturum owner mı (§8) — KVKK anonimleştirme formunun sunulup sunulmayacağını belirler.
   * Varsayılan `true`: auth KAPALI kurulumda `isOwner()` zaten true döner (asıl kapı sunucu
   * aksiyonundaki isOwner() + API OwnerGuard'dır; bu yalnız görünürlük kararı).
   */
  canOwner?: boolean;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const handleError = React.useCallback((message: string) => {
    setNotice(null);
    setError(message);
  }, []);
  const handleScanDone = React.useCallback((n: number) => {
    setError(null);
    setNotice(
      n > 0 ? `Tarama tamamlandı — ${n} yeni olay kaydedildi.` : 'Tarama tamamlandı — yeni olay yok.',
    );
  }, []);
  const handleAnonDone = React.useCallback((orders: number, replacements: number) => {
    setError(null);
    setNotice(
      `Anonimleştirme tamamlandı — ${orders} sipariş, ${replacements} değişim talebi maskelendi.`,
    );
  }, []);

  return (
    <div className="space-y-4">
      {error && (
        <Notice
          variant="destructive"
          title="İşlem tamamlanamadı"
          message={error}
          onClose={() => setError(null)}
        />
      )}
      {notice && (
        <Notice
          variant="success"
          title="Tamamlandı"
          message={notice}
          onClose={() => setNotice(null)}
        />
      )}

      {/* DÜRÜSTLÜK BANDI: liste kırpıldığında "olay yok" izlenimi vermek yanlış bilgidir —
          arama/facet yalnız bu pencere üzerinde çalışır (destek/bildirim ekranlarıyla simetri). */}
      {truncated && (
        <Alert variant="info">
          <Info />
          <div className="min-w-0 flex-1">
            <AlertTitle>Liste eksik olabilir</AlertTitle>
            <AlertDescription>
              Yalnız son {limit ?? events.length} olay gösteriliyor — daha eskiler bu listede YOK.
              Arama ve süzgeçler de yalnız bu pencerede çalışır; yoğun dönemlerde (ör. başarısız
              giriş dalgası) eski kritik olaylar pencereden düşmüş olabilir.
            </AlertDescription>
          </div>
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Otomatik askıya alma yok — olaylar insan onayı için yüzeye çıkar.
        </p>
        <ScanButton onError={handleError} onDone={handleScanDone} />
      </div>

      <DataTable
        columns={columns}
        data={events}
        searchColumnId="detail"
        searchPlaceholder="Detay ara…"
        facets={facets}
        initialSorting={[{ id: 'createdAt', desc: true }]}
        emptyLabel="Güvenlik olayı yok."
      />

      <AnonymizeForm canOwner={canOwner} onError={handleError} onDone={handleAnonDone} />
    </div>
  );
}
