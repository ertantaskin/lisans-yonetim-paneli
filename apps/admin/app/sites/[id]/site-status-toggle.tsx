'use client';
import * as React from 'react';
import { Ban, CircleCheck, TriangleAlert } from 'lucide-react';
import { setSiteStatusAction } from '../actions';
import { Button } from '../../../components/ui/button';

/**
 * Site yaşam döngüsü aksiyonu (§8): askıya al / aktifleştir. 'suspended' → HMAC auth
 * reddedilir (yeni sipariş push'u durur). setSiteStatusAction → PATCH (audit'e düşer).
 * Confirm ister; hata inline gösterilir. revalidatePath sunucuda durumu tazeler.
 */
export function SiteStatusToggle({ siteId, status }: { siteId: string; status: string }) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const suspended = status === 'suspended';
  const next = suspended ? 'active' : 'suspended';

  const toggle = () => {
    const msg = suspended
      ? 'Site yeniden aktifleştirilsin mi? Yeni sipariş push kabulü tekrar açılır.'
      : 'Site askıya alınsın mı? Askıdayken HMAC auth reddedilir — yeni sipariş push edilemez.';
    if (!window.confirm(msg)) return;
    setError(null);
    startTransition(async () => {
      const res = await setSiteStatusAction(siteId, next);
      if (!res.ok) setError(res.error ?? 'Durum değiştirilemedi');
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button
        variant={suspended ? 'default' : 'outline'}
        size="sm"
        onClick={toggle}
        disabled={pending}
      >
        {suspended ? <CircleCheck /> : <Ban />}
        {pending ? 'İşleniyor…' : suspended ? 'Aktifleştir' : 'Askıya Al'}
      </Button>
      {error && (
        <p className="flex items-center gap-1 text-xs text-destructive">
          <TriangleAlert className="size-3.5" /> {error}
        </p>
      )}
    </div>
  );
}
