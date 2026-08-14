'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useLive } from './live-provider';

/**
 * Canlı akışın DİKKAT katmanı — ekranın hangi bölümüne bakıldığından bağımsız çalışır.
 * Kabukta (LiveProvider'ın içinde) BİR KEZ mount edilir, hiçbir şey render etmez.
 *
 * İki iş yapar:
 *  1. **Sekme başlığı sayacı** — görülmemiş sipariş/destek varken başlığa `(3) ` öneki
 *     basar. Operatör başka sekmedeyken (ya da pencere arkadayken) yeni siparişi ancak
 *     buradan fark eder; panel arka planda da dakikada bir tazelendiği için sayaç ilerler.
 *  2. **Toast** — yeni kayıt geldiği ANDA sağ altta tıklanabilir bildirim. Ekranın canlı
 *     listesindeki vurgu 12 sn'de sönüyor ve başka ekranlardayken (ör. /stock) hiçbir
 *     sinyal yoktu; toast o boşluğu kapatır. Tek kayıt → doğrudan siparişe; çok kayıt →
 *     tek özet toast (parti başına bir bildirim, satır başına değil → sel önlenir).
 *
 * Toast HER ekranda çıkar (genel bakış dahil): şikâyet tam olarak "sipariş anlık düşüyor
 * ama fark edilmiyor" idi. Kalıcı iz için `unseen` işareti listede zaten duruyor.
 */
export function LiveAlerts() {
  const { unseen, lastBatch } = useLive();
  const router = useRouter();

  // Yalnız bu mount'tan SONRA gelen partiler bildirilir: sağlayıcı kabukta yaşadığı için
  // bileşen yeniden bağlanırsa eski parti tekrar toast'lanmasın.
  const [mountedAt] = React.useState(() => Date.now());
  const handled = React.useRef(0);

  // ── 1. Sekme başlığı sayacı ────────────────────────────────────────────────
  const count = React.useMemo(() => {
    let n = 0;
    for (const id of unseen) if (id.startsWith('o:') || id.startsWith('s:')) n += 1;
    return n;
  }, [unseen]);

  React.useEffect(() => {
    const titleEl = document.querySelector('title');
    const strip = (t: string) => t.replace(/^\(\d+\)\s+/, '');

    const apply = () => {
      const wanted = count > 0 ? `(${count}) ${strip(document.title)}` : strip(document.title);
      // Yalnız gerçekten değiştiğinde yaz: kendi yazımımız gözlemciyi tetikler, ikinci
      // turda `current === wanted` olduğu için döngü kapanır (sonsuz döngü YOK).
      if (document.title !== wanted) document.title = wanted;
    };

    apply();

    // Next gezinmede <title>'ı KENDİ effect'inde değiştirir ve sıra garantili değildir →
    // başlığı gözlemleyip öneki yeniden basarız (yoksa sayaç gezinmede kaybolurdu).
    if (!titleEl) return;
    const obs = new MutationObserver(apply);
    obs.observe(titleEl, { childList: true, characterData: true, subtree: true });
    return () => {
      obs.disconnect();
      document.title = strip(document.title);
    };
  }, [count]);

  // ── 2. Yeni kayıt toast'ı ──────────────────────────────────────────────────
  React.useEffect(() => {
    if (!lastBatch || lastBatch.at <= mountedAt || lastBatch.at === handled.current) return;
    handled.current = lastBatch.at;

    const { orders, supports } = lastBatch;

    if (orders.length === 1) {
      const o = orders[0];
      toast.success(`Yeni sipariş #${o.remoteOrderId}`, {
        description: [o.siteDomain, o.customerEmail].filter(Boolean).join(' · '),
        duration: 8000,
        action: { label: 'Aç', onClick: () => router.push(`/orders/${o.id}`) },
      });
    } else if (orders.length > 1) {
      toast.success(`${orders.length} yeni sipariş`, {
        description: orders
          .slice(0, 3)
          .map((o) => `#${o.remoteOrderId}`)
          .join(', '),
        duration: 8000,
        action: { label: 'Siparişler', onClick: () => router.push('/orders') },
      });
    }

    if (supports.length === 1) {
      const s = supports[0];
      toast.warning('Yeni destek talebi', {
        description: [s.customerEmail, s.remoteOrderId ? `#${s.remoteOrderId}` : null]
          .filter(Boolean)
          .join(' · '),
        duration: 8000,
        action: {
          label: 'Aç',
          onClick: () => router.push(s.orderId ? `/orders/${s.orderId}` : '/support'),
        },
      });
    } else if (supports.length > 1) {
      toast.warning(`${supports.length} yeni destek talebi`, {
        duration: 8000,
        action: { label: 'Destek', onClick: () => router.push('/support') },
      });
    }
  }, [lastBatch, mountedAt, router]);

  // Görsel çıktısı yok: tüm etkisi document.title ve toast katmanında.
  return null;
}
