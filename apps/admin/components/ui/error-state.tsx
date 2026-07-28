'use client';
import { RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from './button';

/**
 * ErrorState — TÜM route hata sınırlarının (error.tsx) ortak gövdesi.
 *
 * NEDEN ORTAK: panelde 25 adet `error.tsx` aynı deseni kopyalıyordu ve yalnız biri
 * (app/error.tsx) "üretimde redakte edilmiş mesajı gösterme" mantığını taşıyordu →
 * diğer 24 route hata verdiğinde kullanıcıya İngilizce Next kalıbı ("The specific
 * message is omitted in production builds…") çıkıyordu. Mantık tek yerde toplandı;
 * her error.tsx yalnız kendi başlığını verir.
 *
 * ÜRETİMDE Next, sunucu tarafı hata mesajlarını REDAKTE eder ve yerine İngilizce bir
 * kalıp bırakır. Türkçe panelde bu metin kullanıcıya hiçbir şey anlatmaz, üstelik
 * teknik/yabancı görünür. Bu yüzden:
 *   - mesaj redakte edilmişse (digest var ya da bilinen kalıplardan biri) → Türkçe
 *     genel açıklama,
 *   - destek/log eşleştirmesi için ayrıca "Hata kodu: <digest>" gösterilir (digest
 *     sunucu loglarındaki kayda birebir karşılık gelir; sır içermez),
 *   - ham mesaj YALNIZ gerçekten bilgilendiriciyse (geliştirme ortamı ya da istemci
 *     tarafında üretilmiş anlamlı mesaj) gösterilir.
 *
 * Kullanım (route hata sınırı):
 *   'use client';
 *   import { ErrorState } from '../../components/ui/error-state';
 *   export default function Error(props: { error: Error & { digest?: string }; reset: () => void }) {
 *     return <ErrorState {...props} title="Siparişler yüklenemedi" />;
 *   }
 */

/** Next/React'in üretimde ürettiği İngilizce kalıplar — kullanıcıya gösterilmez. */
const REDACTED_PATTERNS = [
  'omitted in production',
  'digest property is included',
  'Server Components render',
  'Minified React error',
  'An unexpected response was received from the server',
];

/** Mesaj kullanıcıya bir şey anlatıyor mu? Anlatmıyorsa Türkçe genel metne düşeriz. */
export function isOpaqueError(error: Error & { digest?: string }): boolean {
  const message = (error?.message ?? '').trim();
  if (!message) return true;
  // Geliştirmede ham mesaj değerlidir (redaksiyon yok) — olduğu gibi göster.
  if (process.env.NODE_ENV !== 'production') return false;
  // digest = sunucu tarafı hata ⇒ mesaj Next tarafından zaten redakte edilmiştir.
  if (error.digest) return true;
  return REDACTED_PATTERNS.some((p) => message.includes(p));
}

export interface ErrorStateProps {
  error: Error & { digest?: string };
  reset: () => void;
  /** Route'a özel başlık — ör. "Siparişler yüklenemedi". Verilmezse genel başlık. */
  title?: string;
  /** Opak mesaj yerine gösterilecek route'a özel açıklama (opsiyonel). */
  description?: string;
}

export function ErrorState({ error, reset, title, description }: ErrorStateProps) {
  const opaque = isOpaqueError(error);
  const fallback =
    description ??
    'Beklenmeyen bir hata oluştu. "Tekrar dene" ile yeniden yükleyebilirsiniz; sorun sürerse aşağıdaki hata kodunu paylaşın.';

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--destructive)_12%,transparent)] text-destructive">
        <TriangleAlert className="size-6" />
      </span>
      <h1 className="text-lg font-semibold text-foreground">{title ?? 'Bir şeyler ters gitti'}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{opaque ? fallback : error.message}</p>
      {error?.digest && (
        <p className="font-mono text-xs text-muted-foreground">Hata kodu: {error.digest}</p>
      )}
      <Button onClick={reset} variant="outline" className="mt-2">
        <RotateCw /> Tekrar dene
      </Button>
    </div>
  );
}
