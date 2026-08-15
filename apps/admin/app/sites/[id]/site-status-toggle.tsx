'use client';
import * as React from 'react';
import { Ban, CircleCheck, TriangleAlert } from 'lucide-react';
import { setSiteStatusAction } from '../actions';
import { Button } from '../../../components/ui/button';
import { useConfirm } from '../../../components/ui/confirm';
import { useAnnouncer } from '../../../components/a11y/announcer';

/**
 * Owner-olmayan operatöre gösterilecek gerekçe (§8 RBAC) — sites-table.tsx ile aynı metin.
 * Aksiyon sunucuda `isOwner()` ile korunuyordu ama düğme AÇIK sunuluyordu: operatör "Askıya al"
 * onayını geçip ancak SONRA "yetkiniz yok" alıyordu.
 */
const OWNER_ONLY_REASON =
  'Bu işlem yalnız Sahip (owner) rolündeki yöneticiler içindir — mağazanın sipariş kabulünü durdurur.';

/**
 * Site yaşam döngüsü aksiyonu (§8): askıya al / aktifleştir. 'suspended' → HMAC auth
 * reddedilir (yeni sipariş push'u durur). setSiteStatusAction → PATCH (audit'e düşer).
 * Confirm ister; hata inline gösterilir. revalidatePath sunucuda durumu tazeler.
 */
export function SiteStatusToggle({
  siteId,
  status,
  canOwner = true,
}: {
  siteId: string;
  status: string;
  /**
   * Oturum owner mı — SUNUCUDAN gelen serileştirilebilir boolean (fonksiyon prop'u YOK).
   * Varsayılan `true`: auth kapalı kurulumda `isOwner()` zaten true döner ve prop'u geçmeyi
   * unutan bir çağıran aksiyonu sessizce kilitlemez (asıl kapı sunucuda + API OwnerGuard).
   */
  canOwner?: boolean;
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const announce = useAnnouncer();
  const { confirm, dialog } = useConfirm();
  const suspended = status === 'suspended';
  const next = suspended ? 'active' : 'suspended';

  const toggle = async () => {
    const ok = await confirm(
      suspended
        ? {
            title: 'Site yeniden aktifleştirilsin mi?',
            description: 'Yeni sipariş push kabulü tekrar açılır.',
            confirmLabel: 'Aktifleştir',
          }
        : {
            title: 'Site askıya alınsın mı?',
            description:
              'Askıdayken HMAC kimlik doğrulaması reddedilir — mağaza yeni sipariş gönderemez. İşlem geri alınabilir.',
            tone: 'danger',
            confirmLabel: 'Askıya al',
          },
    );
    if (!ok) return;
    setError(null);
    startTransition(async () => {
      const res = await setSiteStatusAction(siteId, next);
      if (!res.ok) {
        const em = res.error ?? 'Durum değiştirilemedi';
        setError(em);
        announce(em, { assertive: true });
      } else {
        // Sonuç görsel olarak revalidate ile yansır; okuyucuya da duyur (WCAG 4.1.3).
        announce(next === 'suspended' ? 'Site askıya alındı' : 'Site aktifleştirildi');
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      {dialog}
      <Button
        variant={suspended ? 'default' : 'outline'}
        size="sm"
        onClick={() => void toggle()}
        disabled={pending || !canOwner}
        title={canOwner ? undefined : OWNER_ONLY_REASON}
        aria-label={canOwner ? undefined : `${suspended ? 'Aktifleştir' : 'Askıya Al'} — ${OWNER_ONLY_REASON}`}
      >
        {suspended ? <CircleCheck /> : <Ban />}
        {pending ? 'İşleniyor…' : suspended ? 'Aktifleştir' : 'Askıya Al'}
      </Button>
      {/* Gerekçe GÖRÜNÜR: devre dışı düğmenin tooltip'i her tarayıcıda/klavyede açılmaz. */}
      {!canOwner && (
        <p className="max-w-56 text-right text-xs text-muted-foreground">{OWNER_ONLY_REASON}</p>
      )}
      {error && (
        <p className="flex items-center gap-1 text-xs text-destructive">
          <TriangleAlert className="size-3.5" /> {error}
        </p>
      )}
    </div>
  );
}
