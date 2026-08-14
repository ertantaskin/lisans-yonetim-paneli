'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Power, TriangleAlert } from 'lucide-react';
import { activateMappingWithResult } from './actions';
import { Button } from '../../components/ui/button';
import { useAnnouncer } from '../../components/a11y/announcer';

/**
 * "Etkinleştir" — PASİF bir eşlemeyi geri açar (§3).
 *
 * NEDEN VAR (denetim bulgusu): eşleme pasifken okuma yolları onu HİÇ saymıyor (satır ekranda
 * "Eşlenmemiş" görünüyordu) ama `createMapping`'in mükerrer ön-kontrolü aynı anahtar için ikinci
 * satıra izin vermiyor → operatör "Eşle" deyip 409 alıyor ve çıkmaz sokakta kalıyordu. Bu düğme
 * doğru eylemi tek tıkla yapar: yeni eşleme kurmaz, mevcut olanı etkinleştirir ve eşleme pasifken
 * gelmiş bekleyen satırları geriye dönük çözmeyi dener.
 *
 * Sonuç DÜRÜSTÇE gösterilir: sunucu ne yaptıysa o yazılır (sessiz "başarılı" yok — bu panelde
 * yaşanmış bir hata sınıfı). Hem katalog hem "Eşlenmemiş Gelen Ürünler" tablosu bunu kullanır.
 */
export function ActivateMappingButton({
  mappingId,
  label,
  siteId,
  remoteProductId,
  remoteVariationId,
}: {
  mappingId: string;
  /** Duyuru/aria metni için mağaza ürün adı. */
  label: string;
  /** Geriye dönük çözüm kapsamı — verilmezse yalnız etkinleştirme yapılır. */
  siteId?: string;
  remoteProductId?: string;
  remoteVariationId?: string | null;
}) {
  const router = useRouter();
  const announce = useAnnouncer();
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const run = () => {
    setError(null);
    start(async () => {
      const res = await activateMappingWithResult(mappingId, {
        ...(siteId ? { siteId } : {}),
        ...(remoteProductId ? { remoteProductId } : {}),
        // null ANLAMLI ("varyasyonsuz satırlar"); undefined ise alan hiç gönderilmez.
        ...(remoteVariationId !== undefined ? { remoteVariationId } : {}),
      });
      if (res.ok) {
        const extra = res.resolved
          ? ` Bekleyen ${res.resolved.linked} satır bağlandı, ${res.resolved.delivered} tanesi teslim edildi.`
          : '';
        announce(`${label} eşlemesi etkinleştirildi.${extra}`);
        router.refresh();
      } else {
        const message = res.error ?? 'Eşleme etkinleştirilemedi';
        setError(message);
        announce(message, { assertive: true });
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={run}
        aria-label={`${label} eşlemesini etkinleştir`}
      >
        <Power aria-hidden /> {pending ? 'Etkinleştiriliyor…' : 'Etkinleştir'}
      </Button>
      {error && (
        <span className="flex items-center gap-1 text-xs text-destructive">
          <TriangleAlert className="size-3.5" aria-hidden /> {error}
        </span>
      )}
    </div>
  );
}
