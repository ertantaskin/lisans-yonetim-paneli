'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

/**
 * Aktif dağıtım varken sayfayı hafifçe tazeler (§16).
 *
 * NEDEN: sayfa sunucu-taraflı render edilir ve dağıtımı host runner (cron) yürütür. "Prod'a
 * dağıt" sonrası tablo 'bekliyor' durumunda DONUYORDU; operatör dakikalarca bakıp işin takıldığını
 * sanıyor ve ikinci kez tetiklemeye çalışıyordu (409). Artık YALNIZ pending/running bir dağıtım
 * varken 10 sn'de bir `router.refresh()` çağrılır; iş bitince (props'ta aktif kalmayınca) poll
 * kendiliğinden durur → boşta ağ trafiği yok.
 *
 * Gizli sekmede DURUR (panelin mevcut canlı-poller deseni): arka planda açık unutulmuş sekme
 * sunucuyu yormaz; sekmeye dönüldüğünde hemen bir kez tazeler.
 */
export function DeploymentsAutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();

  React.useEffect(() => {
    if (!active) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    const start = () => {
      if (timer === null) timer = setInterval(tick, 10_000);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        router.refresh(); // sekmeye dönüşte bekletme yok
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, router]);

  if (!active) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      Aktif bir dağıtım var — durum 10 saniyede bir kendiliğinden güncelleniyor.
    </p>
  );
}
