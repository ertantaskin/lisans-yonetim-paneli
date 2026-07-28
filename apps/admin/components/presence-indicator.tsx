'use client';
import { useEffect, useRef, useState } from 'react';
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

/** Ardışık hatada üstel geri çekilme tavanı (live-provider ile aynı sınır). */
const MAX_BACKOFF_MS = 120_000;

/**
 * Auth KAPALIYKEN sunucunun döndürdüğü PAYLAŞILAN kimlik.
 *
 * `lib/session.getActor()` oturum yoksa/auth kapalıysa bu değeri üretir; 'server-only'
 * olduğu için buradan import EDİLEMEZ → bilinçli ayna sabit. Değeri değişirse presence
 * yalnız gereksiz poll'a döner (yanlış rozet göstermez), bu yüzden risk düşüktür.
 */
const SHARED_ACTOR = 'panel:admin';

/**
 * Operatör çakışma uyarısı (§14). Aynı kaynağı (ör. aynı sipariş sayfası) görüntüleyen
 * BAŞKA operatör varsa küçük, dikkat dağıtmayan bir sarı rozet gösterir — iki admin aynı
 * kaydı aynı anda işlemesin. Kimse yoksa hiçbir şey render etmez (null). Best-effort:
 * hata sessizce yutulur, kabuğu kırmaz.
 *
 * POLL DAVRANIŞI (kullanıcı şartı: "tarayıcıda gün boyu açık kalınca gereksiz yük olmasın")
 * — `live/live-provider.tsx`'teki duraklat/planla deseninin birebir aynısı:
 *  - Sekme GİZLİYKEN istek atılmaz; görünür olunca ANINDA bir kez vurulur.
 *  - Ardışık hatada üstel geri çekilme (15sn → 120sn tavan); başarıda sayaç sıfırlanır.
 *  - Unmount'ta zamanlayıcı ve olay dinleyicisi temizlenir; uçuştaki yanıt state yazmaz.
 *  - AUTH KAPALIYSA döngü KALICI durur: o modda tüm operatörler aynı kimliği paylaşır
 *    ('panel:admin'), "başka operatör" ayrımı yapılamaz ve rozet hiçbir zaman çizilemez —
 *    yani 15 sn'de bir atılan istek tamamen etkisizdi. Aynı şekilde oturum sonlanıp istek
 *    /login'e yönlendiğinde de susarız (sayfa yönlendirmesini canlı akış sağlayıcısı yapar).
 */
export function PresenceIndicator({ resource }: Props) {
  const pathname = usePathname();
  const key = resource ?? pathname;
  const [others, setOthers] = useState<string[]>([]);

  /**
   * "Bu oturumda presence çalışmıyor" kararı (auth kapalı / oturum bitti) — kaynak (key)
   * değişip effect yeniden kurulduğunda da korunur, aksi halde her gezinmede yeniden
   * denenip aynı sonuca varılırdı.
   */
  const disabled = useRef(false);

  useEffect(() => {
    if (!key || disabled.current) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let inFlight = false;

    /** Döngüyü bu effect ömrü boyunca durdur (unmount veya kalıcı devre dışı bırakma). */
    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      const delay =
        failures > 0
          ? Math.min(HEARTBEAT_MS * 2 ** Math.min(failures, 3), MAX_BACKOFF_MS)
          : HEARTBEAT_MS;
      timer = setTimeout(() => void run(), delay);
    };

    async function beat(): Promise<void> {
      if (inFlight) return; // görünürlük tetiği ile zamanlayıcı çakışırsa çift istek atma
      inFlight = true;
      try {
        const res = await fetch('/api/presence', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ resource: key }),
        });

        // Oturum bitmiş: middleware isteği /login'e yönlendirir ve HTML döner. Presence
        // best-effort olduğu için burada sayfayı YÖNLENDİRMEYİZ (bunu canlı akış sağlayıcısı
        // yapar) — yalnız kalıcı olarak susarız, yoksa her 15 sn'de bir login HTML'i çekilir.
        if (res.redirected && new URL(res.url).pathname === '/login') {
          disabled.current = true;
          stop();
          return;
        }

        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as PresenceResponse;
        if (stopped) return; // unmount edildiyse state'e dokunma
        failures = 0;

        // Auth kapalı (ya da kimlik yok): herkes aynı actor'ı paylaşır → rozet asla
        // çizilemez. Döngüyü kalıcı durdur (tamamen etkisiz istek atmayalım).
        if (!data.self || data.self === SHARED_ACTOR) {
          setOthers([]);
          disabled.current = true;
          stop();
          return;
        }

        // Kendini (self) ve boş kayıtları ele — yalnız DİĞER operatörler.
        setOthers((data.present ?? []).filter((a) => a && a !== data.self));
      } catch {
        // Presence best-effort — hata sessizce yutulur, ama geri çekilerek tekrar denenir.
        failures += 1;
      } finally {
        inFlight = false;
      }
    }

    async function run(): Promise<void> {
      if (stopped) return;
      // Sekme arka plandaysa istek ATMA; yalnız bir sonraki denemeyi planla (ağ/DB yükü yok).
      if (typeof document !== 'undefined' && document.hidden) {
        schedule();
        return;
      }
      await beat();
      schedule();
    }

    const onVisibility = () => {
      if (!document.hidden) void run(); // görünür olur olmaz tazele (bayat rozet kalmasın)
    };

    void run();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
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
