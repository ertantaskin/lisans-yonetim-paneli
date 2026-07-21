'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Users } from 'lucide-react';

interface Props {
  /** İzlenecek kaynak anahtarı. Verilmezse geçerli sayfa yolu (usePathname) kullanılır. */
  resource?: string;
}

/** Presence proxy yanıtı — kendi actor kimliği (self) hariç diğerlerini süzeriz. */
interface PresenceResponse {
  present: string[];
  self: string;
}

/** Heartbeat aralığı (ms) — sunucu TTL'inden (30sn) belirgin kısa olmalı ki düşmesin. */
const HEARTBEAT_MS = 15_000;

/**
 * Operatör çakışma uyarısı (§14). Aynı kaynağı (ör. aynı sipariş sayfası) görüntüleyen
 * BAŞKA operatör varsa küçük, dikkat dağıtmayan bir sarı rozet gösterir — iki admin aynı
 * kaydı aynı anda işlemesin. Kimse yoksa hiçbir şey render etmez (null). Best-effort:
 * hata sessizce yutulur, kabuğu kırmaz.
 */
export function PresenceIndicator({ resource }: Props) {
  const pathname = usePathname();
  const key = resource ?? pathname;
  const [others, setOthers] = useState<string[]>([]);

  useEffect(() => {
    if (!key) return;
    let active = true;

    async function beat(): Promise<void> {
      try {
        const res = await fetch('/api/presence', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ resource: key }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as PresenceResponse;
        if (!active) return;
        // Kendini (self) ve boş kayıtları ele — yalnız DİĞER operatörler.
        setOthers((data.present ?? []).filter((a) => a && a !== data.self));
      } catch {
        // Presence best-effort — hata sessizce yutulur.
      }
    }

    void beat();
    const timer = setInterval(() => void beat(), HEARTBEAT_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [key]);

  if (others.length === 0) return null;

  // Actor kimliğini insan-okur biçime indir ('admin:x@y' → 'x@y').
  const names = others.map((a) => a.replace(/^admin:/, ''));
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs font-medium text-warning"
      title={`Bu sayfada ayrıca: ${names.join(', ')}`}
    >
      <Users className="size-3.5" />
      {others.length} kişi daha bu sayfada
    </span>
  );
}
