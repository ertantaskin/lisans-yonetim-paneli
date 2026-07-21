'use client';
import * as React from 'react';

/**
 * Paylaşılan ekran-okuyucu duyurucusu (WCAG 4.1.3 — Status Messages).
 *
 * Sonner toast'ları kendi aria-live'ını taşır; ancak kritik operatör aksiyonları
 * (revoke/suspend/resend) sonuçlarını inline metinle gösterir → ekran okuyucuya
 * DUYURULMAZ. Bu bölge o boşluğu kapatır: kabuğa bir kez monte edilen, DOM'da HEP
 * mevcut iki görünmez canlı-bölge (polite + assertive) tutar. Bölgeler önceden var
 * olduğundan metin sonradan değişince okuyucu güvenilir seslendirir (sonradan
 * mount'ta atlanmaz). Durum/başarı → polite (sıra bekler), hata → assertive (keser).
 */

type AnnounceOpts = { assertive?: boolean };
type AnnounceFn = (text: string, opts?: AnnounceOpts) => void;

// Provider dışında kullanılırsa güvenli no-op (çökme yok).
const AnnouncerContext = React.createContext<AnnounceFn>(() => {});

/** Kritik aksiyon sonucunu ekran okuyucuya duyurmak için kararlı `announce` fonksiyonu. */
export function useAnnouncer(): AnnounceFn {
  return React.useContext(AnnouncerContext);
}

export function AnnouncerProvider({ children }: { children: React.ReactNode }) {
  // announce ref üzerinden yalnız LiveRegion'ı günceller → context değeri kararlı
  // kalır, çağrı tüm sayfa ağacını yeniden RENDER ETMEZ (perf koruması).
  const emitRef = React.useRef<AnnounceFn>(() => {});
  const announce = React.useCallback<AnnounceFn>((text, opts) => {
    emitRef.current(text, opts);
  }, []);

  return (
    <AnnouncerContext.Provider value={announce}>
      {children}
      <LiveRegion emitRef={emitRef} />
    </AnnouncerContext.Provider>
  );
}

function LiveRegion({ emitRef }: { emitRef: React.MutableRefObject<AnnounceFn> }) {
  const [polite, setPolite] = React.useState('');
  const [assertive, setAssertive] = React.useState('');

  React.useEffect(() => {
    emitRef.current = (text, opts) => {
      const set = opts?.assertive ? setAssertive : setPolite;
      // Aynı metin ardışık geldiğinde de seslendirilsin diye önce boşalt, sonra
      // bir sonraki frame'de yaz (bazı okuyucular değişmeyen metni tekrar okumaz).
      set('');
      requestAnimationFrame(() => set(text));
    };
    return () => {
      emitRef.current = () => {};
    };
  }, [emitRef]);

  return (
    <>
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {polite}
      </span>
      <span aria-live="assertive" aria-atomic="true" className="sr-only">
        {assertive}
      </span>
    </>
  );
}
