'use client';
import * as React from 'react';
import { EMPTY_LIVE, type LivePayload } from '../../lib/live-types';

const POLL_MS = 15_000;
const MAX_BACKOFF_MS = 120_000;
const SOUND_KEY = 'lisans.live.sound';

interface LiveContextValue {
  data: LivePayload;
  /** İlk veri gelene kadar true. */
  loading: boolean;
  /** Ardışık hata sayısı (>0 ise bağlantı sorunlu). */
  errorCount: number;
  /** Son BAŞARILI güncelleme (epoch ms) — 0 ise hiç veri alınmadı. */
  updatedAt: number;
  /** Bu oturumda YENİ görülen kayıt id'leri (vurgulama için). */
  fresh: ReadonlySet<string>;
  /** Sekme görünür mü (poll duraklatıldı mı). */
  active: boolean;
  soundEnabled: boolean;
  setSoundEnabled: (on: boolean) => void;
  refresh: () => void;
  markRead: (ids?: string[]) => Promise<void>;
}

const LiveContext = React.createContext<LiveContextValue | null>(null);

/**
 * Canlı akış sağlayıcısı (§17) — panelin "iş istasyonu" damarı.
 *
 * Tasarım kararları (kullanıcı: "tarayıcımda gün boyu açık kalacak, gereksiz yük olmasın"):
 *  - TEK poller: çan + genel bakış aynı veriyi paylaşır (ekran başına ayrı istek YOK).
 *  - Sekme gizliyken poll DURUR (`document.hidden`), görünür olunca ANINDA tazelenir.
 *  - Koşullu istek: ETag eşleşirse sunucu 304 döner, gövde hiç taşınmaz.
 *  - Hata olursa üstel geri çekilme (15s → 120s tavan) — API kapalıyken saniyede istek yağmuru olmaz.
 *  - SSE/WebSocket bilinçli TERCİH EDİLMEDİ: Caddy arkasında kalıcı bağlantı + sekme başına
 *    açık soket, 15 sn'lik ucuz koşullu poll'a göre net bir kazanç sağlamıyordu; poll ayrıca
 *    yeniden bağlanma/karmaşa üretmiyor.
 */
export function LiveProvider({ children, limit = 15 }: { children: React.ReactNode; limit?: number }) {
  const [data, setData] = React.useState<LivePayload>(EMPTY_LIVE);
  const [loading, setLoading] = React.useState(true);
  const [errorCount, setErrorCount] = React.useState(0);
  const [updatedAt, setUpdatedAt] = React.useState(0);
  const [fresh, setFresh] = React.useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = React.useState(true);
  const [soundEnabled, setSoundEnabledState] = React.useState(false);

  const etag = React.useRef<string | null>(null);
  const seen = React.useRef<Set<string> | null>(null); // ilk yükte "hepsi yeni" saymamak için null
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = React.useRef(false);
  const failures = React.useRef(0);
  const soundRef = React.useRef(false);
  const freshTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const expired = React.useRef(false);

  React.useEffect(() => {
    try {
      const on = window.localStorage.getItem(SOUND_KEY) === '1';
      soundRef.current = on;
      setSoundEnabledState(on);
    } catch {
      /* localStorage kapalı olabilir (gizli mod) — sessizce varsayılan kalır */
    }
  }, []);

  const setSoundEnabled = React.useCallback((on: boolean) => {
    soundRef.current = on;
    setSoundEnabledState(on);
    try {
      window.localStorage.setItem(SOUND_KEY, on ? '1' : '0');
    } catch {
      /* yoksay */
    }
    if (on) beep();
  }, []);

  const tick = React.useCallback(async () => {
    if (inFlight.current || expired.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(`/api/live?limit=${limit}`, {
        headers: etag.current ? { 'if-none-match': etag.current } : undefined,
        cache: 'no-store',
      });

      // Oturum süresi doldu: middleware poll'u /login'e yönlendirir ve HTML döner.
      // Panel gün boyu açık kalacağı için bu SESSİZCE "bağlantı yok"a düşerse operatör
      // bayat tabloya bakmaya devam eder. Poll'u kalıcı durdur + giriş ekranına götür.
      if (res.redirected && new URL(res.url).pathname === '/login') {
        expired.current = true;
        window.location.assign(`/login?from=${encodeURIComponent(window.location.pathname)}`);
        return;
      }

      if (res.status === 304) {
        failures.current = 0;
        setErrorCount(0);
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));

      const next = (await res.json()) as LivePayload;
      const tag = res.headers.get('etag');
      if (tag) etag.current = tag;

      const ids = collectIds(next);
      if (seen.current === null) {
        seen.current = ids; // ilk yük: mevcut her şey "eski"
        setFresh(new Set());
      } else {
        const added = new Set<string>();
        for (const id of ids) if (!seen.current.has(id)) added.add(id);
        seen.current = ids;
        if (added.size) {
          setFresh(added);
          // Vurgu 12 sn sonra sönümlenir (dikkat çeker ama kalıcı gürültü yapmaz).
          // Önceki zamanlayıcı İPTAL edilir: art arda gelen iki parti olduğunda eskisinin
          // timeout'u yeni vurguyu erkenden söndürmesin (ve unmount'ta sızıntı olmasın).
          if (freshTimer.current) clearTimeout(freshTimer.current);
          freshTimer.current = setTimeout(() => setFresh(new Set()), 12_000);
          if (soundRef.current) beep();
        }
      }

      setData(next);
      setUpdatedAt(Date.now());
      failures.current = 0;
      setErrorCount(0);
      setLoading(false);
    } catch {
      failures.current += 1;
      setErrorCount(failures.current);
      setLoading(false);
    } finally {
      inFlight.current = false;
    }
  }, [limit]);

  // Poll döngüsü — gizli sekmede DURUR, görünür olunca anında tazelenir.
  React.useEffect(() => {
    let stopped = false;

    const schedule = () => {
      if (stopped) return;
      if (timer.current) clearTimeout(timer.current);
      const delay =
        failures.current > 0
          ? Math.min(POLL_MS * 2 ** Math.min(failures.current, 4), MAX_BACKOFF_MS)
          : POLL_MS;
      timer.current = setTimeout(run, delay);
    };

    const run = async () => {
      if (typeof document !== 'undefined' && document.hidden) {
        schedule();
        return;
      }
      await tick();
      schedule();
    };

    const onVisibility = () => {
      const visible = !document.hidden;
      setActive(visible);
      if (visible) void run();
    };

    void run();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
      if (freshTimer.current) clearTimeout(freshTimer.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [tick]);

  const refresh = React.useCallback(() => {
    failures.current = 0;
    void tick();
  }, [tick]);

  const markRead = React.useCallback(
    async (ids?: string[]) => {
      // İyimser güncelleme: rozet anında düşer, sonraki poll gerçeği doğrular.
      setData((d) => ({
        ...d,
        notifications: {
          unread: ids ? Math.max(0, d.notifications.unread - ids.length) : 0,
          recent: d.notifications.recent.map((n) =>
            !ids || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n,
          ),
        },
      }));
      try {
        await fetch('/api/notifications/read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(ids?.length ? { ids } : { all: true }),
        });
      } catch {
        /* best-effort — sonraki poll gerçek durumu geri getirir */
      }
      etag.current = null; // ETag'i geçersiz kıl ki bir sonraki poll taze veri çeksin
      void tick();
    },
    [tick],
  );

  const value: LiveContextValue = {
    data,
    loading,
    errorCount,
    updatedAt,
    fresh,
    active,
    soundEnabled,
    setSoundEnabled,
    refresh,
    markRead,
  };

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

/**
 * Canlı akışa abone ol. Sağlayıcı yoksa (ör. giriş ekranı) GÜVENLİ boş değer döner —
 * bileşenler koşulsuz kullanabilir, hook kuralları bozulmaz.
 */
export function useLive(): LiveContextValue {
  const ctx = React.useContext(LiveContext);
  return ctx ?? FALLBACK;
}

const FALLBACK: LiveContextValue = {
  data: EMPTY_LIVE,
  loading: false,
  errorCount: 0,
  updatedAt: 0,
  fresh: new Set(),
  active: false,
  soundEnabled: false,
  setSoundEnabled: () => {},
  refresh: () => {},
  markRead: async () => {},
};

/** Yanıttaki tüm kayıt id'leri — "yeni geldi mi" karşılaştırması için. */
function collectIds(p: LivePayload): Set<string> {
  const s = new Set<string>();
  for (const o of p.orders) s.add(`o:${o.id}`);
  for (const r of p.supports) s.add(`s:${r.id}`);
  for (const n of p.notifications.recent) s.add(`n:${n.id}`);
  return s;
}

/**
 * Kısa bildirim sesi — DOSYA/İNDİRME YOK: WebAudio ile yerinde üretilir (harici istek yok,
 * CSP dostu). Tarayıcı otomatik oynatmayı engellerse sessizce yutulur; ses yalnız kullanıcı
 * açıkça açtığında çalar (varsayılan KAPALI).
 */
function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1174, ctx.currentTime + 0.09);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
    osc.onended = () => void ctx.close().catch(() => {});
  } catch {
    /* ses yoksa sorun değil */
  }
}
