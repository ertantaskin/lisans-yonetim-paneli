import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import {
  Archive,
  Banknote,
  CalendarX2,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Ban,
  Boxes,
  Lock,
  PackageCheck,
  PauseCircle,
  Mail,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Unlink,
  type LucideIcon,
} from 'lucide-react';
import {
  badgeStatusLabel,
  claimOutcomeLabel,
  claimStatusLabel,
  supplyStatusLabel,
} from '../../lib/labels';
import { cn } from '../../lib/utils';

/**
 * Rozet görünümü: CANLI tint + saç teli halka (ring) + koyu, okunur metin.
 *
 * RENK İKİ KATMANDIR (globals.css, ölçülerek kuruldu):
 *   • dolgu/halka → `--<hue>-fill` / `--<hue>-ring` (canlı `-vivid` tabandan seyreltilmiş,
 *     oran temaya göre değişir; TEK KAYNAK — eskiden aynı dil dört ayrı yüzdeyle kopyalanmıştı)
 *   • metin/ikon  → `--<hue>` (küçük metin ⇒ AA zorunlu, ölçülen 4.66–7.25:1)
 * Referans (shadcnspace) tek renk kullanıp metni de canlı yapıyor; ölçüldü, kontrast 2.2–3.3
 * ile AA'nın altında kalıyor → canlılık YÜZEYE alındı, okunabilirlik metinde korundu.
 *
 * GEOMETRİ referanstan ölçüldü: **h-5 (20px)** sabit yükseklik · `px-2` · `gap-1` · ikon 12px.
 * Sabit yükseklik bilinçli: eskiden `py-0.5` ile yükseklik içeriğe göre 20-22px arası
 * oynuyordu ve aynı tablo satırındaki iki rozet farklı boyda duruyordu. `whitespace-nowrap`
 * şart — sabit yükseklikte sarma olursa metin pill'in dışına taşar.
 * Ağırlık 500 → **600**: referansın semantik rozeti de 600; küçük punto renkli metinde
 * kalınlık okunabilirliği kontrast kadar etkiler.
 */
const badgeVariants = cva(
  'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-semibold leading-none ring-1 ring-inset [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        neutral: 'bg-secondary text-secondary-foreground ring-border/70',
        accent: 'bg-secondary text-foreground ring-border/70',
        success: 'bg-(--success-fill) text-success ring-(--success-ring)',
        info: 'bg-(--info-fill) text-info ring-(--info-ring)',
        warning: 'bg-(--warning-fill) text-warning ring-(--warning-ring)',
        attention: 'bg-(--attention-fill) text-attention ring-(--attention-ring)',
        danger: 'bg-(--destructive-fill) text-destructive ring-(--destructive-ring)',
        outline: 'bg-transparent text-muted-foreground ring-border',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

// ── Durum → renk/ikon (§17: tek durum dili, pill+ikon) ───────────────────────
// METİN burada DEĞİL: Türkçe etiket `lib/labels.ts` → `badgeStatusLabel` (TEK KAYNAK).
// Burada yalnız GÖRSEL eşleme (renk varyantı + ikon) durur.
//
// TON KURALI — BEŞ HUE (yeni durum eklerken buna göre seç):
//   success   emerald → sağlıklı KAYNAK, satılmaya hazır   (Stokta · Aktif · Teslim alındı)
//   info      mavi    → TAMAMLANMIŞ iş, müşteride          (Teslim edildi · Gönderildi · Onaylandı)
//   warning   amber   → BEKLİYOR, kendiliğinden ilerler    (Bekliyor · Kısmi · Rezerve · Kuyrukta)
//   attention mor     → İNSAN KARARI bekliyor, hata değil  (İncelemede · Askıda)
//   danger    rose    → ÖLÜ / HATALI / ENGELLİ             (Geri alındı · Geçersiz · Başarısız · Eşlenmemiş)
//   neutral   gri     → kapanmış, eylem yok                (Değiştirildi · İptal · Tükendi · Süresi doldu)
//
// NEDEN BEŞ HUE (eskiden üçtü): "Stokta" ve "Teslim edildi" AYNI yeşildi — kullanıcı
// geri bildirimi: envanterde hangi anahtarın hâlâ satılabilir olduğu bir bakışta
// anlaşılmıyordu. Ayrım artık RENKTE: yeşil = elimde, mavi = müşteride.
// AYNI TON içindeki durumlar İKON + ETİKET ile ayrışır (ton başına tek hue).
type StatusMeta = { variant: NonNullable<BadgeProps['variant']>; icon: LucideIcon };

const STATUS: Record<string, StatusMeta> = {
  // ── TAMAMLANMIŞ (mavi): iş bitti, değer müşteriye geçti ──
  fulfilled: { variant: 'info', icon: PackageCheck },
  // `assigned` (envanter) ile `fulfilled` (sipariş) AYNI kelimeyi yazar ("Teslim edildi") →
  // aynı renk + aynı ikon olmalı, yoksa iki ekran çelişir (kullanıcı geri bildirimi).
  assigned: { variant: 'info', icon: PackageCheck },
  delivered: { variant: 'info', icon: PackageCheck },
  sent: { variant: 'info', icon: Mail },
  approved: { variant: 'info', icon: CheckCircle2 },
  // ── SAĞLIKLI KAYNAK (yeşil): hâlâ elimde, satılabilir ──
  available: { variant: 'success', icon: Boxes },
  active: { variant: 'success', icon: CheckCircle2 },
  // ── BEKLİYOR (amber): süreç kendiliğinden ilerler ──
  partial: { variant: 'warning', icon: Clock },
  pending: { variant: 'warning', icon: Clock },
  open: { variant: 'warning', icon: Clock },
  info_requested: { variant: 'warning', icon: Mail },
  queued: { variant: 'warning', icon: Loader2 },
  reserved: { variant: 'warning', icon: Lock },
  // ── İNSAN KARARI (mor): operatör onaylamadan ilerlemez, ama hata DEĞİL ──
  held_for_review: { variant: 'attention', icon: ShieldAlert },
  suspended: { variant: 'attention', icon: PauseCircle },
  // ── ÖLÜ / HATALI / ENGELLİ (rose) ──
  rejected: { variant: 'danger', icon: Ban },
  unmapped: { variant: 'danger', icon: Unlink },
  revoked: { variant: 'danger', icon: Ban },
  failed: { variant: 'danger', icon: AlertTriangle },
  bounced: { variant: 'danger', icon: AlertTriangle },
  quarantined: { variant: 'danger', icon: ShieldAlert },
  voided: { variant: 'danger', icon: Ban },
  // ── KAPANMIŞ (nötr): beklenen son, eylem yok ──
  replaced: { variant: 'neutral', icon: RefreshCw },
  canceled: { variant: 'neutral', icon: Ban },
  depleted: { variant: 'neutral', icon: Archive },
  // Süre bitişi beklenen bir sondur (§2 süreli hesap) — alarm değil, kapanmış kayıt.
  expired: { variant: 'neutral', icon: CalendarX2 },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const meta = STATUS[status] ?? { variant: 'neutral' as const, icon: Clock };
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className={className}>
      <Icon />
      {badgeStatusLabel(status)}
    </Badge>
  );
}

// ── Tedarik zinciri durumu (parti / satın alma emri) ─────────────────────────
/**
 * NEDEN AYRI BİLEŞEN: tedarik kendi sözlüğüne sahiptir (`supplyStatusLabel`) ve bazı
 * anahtarlar sipariş diliyle ÇAKIŞIR — ör. `partial` siparişte "Kısmi teslim", satın alma
 * emrinde "Kısmi (teslim alındı)". İki sözlüğü tek haritada birleştirmek yanlış METİN
 * üretirdi. Görsel dil (pill + ikon + ton kuralı) ise `StatusBadge` ile AYNIDIR.
 *
 * NEDEN TEK KAYNAK: bu eşleme panelde DÖRT ayrı yerde kopyalanmıştı ve birbiriyle
 * çelişiyordu — `voided` tedarikçi karnesinde amber / ürün detayında kırmızı; `ordered`
 * satın alma emri listesinde gri / ürün detayında amber; PO listesi etiketleri sözlüğü
 * atlayıp elle küçük harf yazıyordu ("taslak"), ikisi de ikonsuzdu.
 */
const SUPPLY_STATUS: Record<string, StatusMeta> = {
  draft: { variant: 'outline', icon: Clock },
  ordered: { variant: 'warning', icon: Clock },
  partial: { variant: 'warning', icon: Boxes },
  received: { variant: 'success', icon: CheckCircle2 },
  active: { variant: 'success', icon: CheckCircle2 },
  recalled: { variant: 'danger', icon: ShieldAlert },
  voided: { variant: 'danger', icon: Ban },
  cancelled: { variant: 'danger', icon: Ban },
  canceled: { variant: 'danger', icon: Ban },
};

export function SupplyStatusBadge({ status, className }: { status: string; className?: string }) {
  const meta = SUPPLY_STATUS[status] ?? { variant: 'neutral' as const, icon: Clock };
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className={className}>
      <Icon />
      {supplyStatusLabel(status)}
    </Badge>
  );
}

// ── Tedarikçi değişim fişi (§12) ─────────────────────────────────────────────
/**
 * NEDEN YİNE AYRI BİLEŞEN: fiş sözlüğü mevcut rozet anahtarlarıyla ÇAKIŞIYOR ve aynı
 * anahtar farklı ŞEY demek — `pending` sipariş dilinde "Bekliyor", fişte "Cevap bekleniyor";
 * `replaced` sipariş dilinde "Değiştirildi" (ölü anahtar), fişte "Yenisi geldi" (İYİ haber);
 * `rejected` destek dilinde müşteri talebinin reddi, fişte TEDARİKÇİNİN reddi. Tek haritada
 * birleştirmek `SupplyStatusBadge`'i doğuran hatanın aynısını üretirdi.
 *
 * Ton kuralı yukarıdaki BEŞ HUE ile aynı — yeni renk EKLENMEZ:
 * Ton kuralı yukarıdaki BEŞ HUE ile aynı — YENİ RENK EKLENMEZ, ama her durum AYRI bir tonda
 * olmalı (kullanıcı bulgusu: "rozetler ayırt edilemiyor"). Eskiden dört durumdan ÜÇÜ griydi ve
 * `closed`/`canceled` BİREBİR aynı nötr rozetti (yalnız ikon farklıydı) → listede tarama imkânsız:
 *   Taslak    → attention (mor): İŞ SENDE — indirilip gönderilmesi gereken fiş. Panelde mor
 *               "insan kararı bekliyor" demektir (İncelemede/Askıda ile aynı anlam).
 *   Gönderildi→ info (mavi): eylem tamam, top KARŞI TARAFTA.
 *   Kapandı   → neutral (gri): kapanmış kayıt (nötrün tanımı).
 *   İptal     → danger (kırmızı): fiş yanlış kesilmiş, kalemleri havuza dönmüş = ölü kayıt.
 *               Panelin geri kalanıyla da tutarlı (SUPPLY_STATUS `canceled` zaten danger).
 * Kalem yanıtları: Cevap bekleniyor → warning · Yenisi geldi / Bedeli iade → success ·
 * Reddedildi → danger. AYNI TON İÇİNDE AYRIM İKONLA: "Yenisi geldi" (RefreshCw) ile "Bedeli
 * iade edildi" (Banknote) eskiden aynı yeşil + AYNI ikondu → yalnız metinden ayırt ediliyordu.
 */
const CLAIM_STATUS_META: Record<string, StatusMeta> = {
  draft: { variant: 'attention', icon: Clock },
  sent: { variant: 'info', icon: PackageCheck },
  closed: { variant: 'neutral', icon: CheckCircle2 },
  canceled: { variant: 'danger', icon: Ban },
};

const CLAIM_OUTCOME_META: Record<string, StatusMeta> = {
  pending: { variant: 'warning', icon: Clock },
  replaced: { variant: 'success', icon: RefreshCw },
  credited: { variant: 'success', icon: Banknote },
  rejected: { variant: 'danger', icon: Ban },
};

export function ClaimStatusBadge({ status, className }: { status: string; className?: string }) {
  const meta = CLAIM_STATUS_META[status] ?? { variant: 'neutral' as const, icon: Clock };
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className={className}>
      <Icon />
      {claimStatusLabel(status)}
    </Badge>
  );
}

export function ClaimOutcomeBadge({ outcome, className }: { outcome: string; className?: string }) {
  const meta = CLAIM_OUTCOME_META[outcome] ?? { variant: 'neutral' as const, icon: Clock };
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className={className}>
      <Icon />
      {claimOutcomeLabel(outcome)}
    </Badge>
  );
}
