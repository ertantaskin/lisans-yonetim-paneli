'use client';
import { ErrorState } from '../../components/ui/error-state';

/**
 * Başarısız işler (/ops) route hata sınırı. Ortak gövde/redaksiyon:
 * components/ui/error-state.tsx.
 *
 * NOT: başlık sayfanın kendi başlığıyla ("Başarısız İşler", app/ops/page.tsx + nav.ts)
 * hizalandı — burada kalan "Dead-letter" ham jargonu UX temizliğinden geriye kalmıştı.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} title="Başarısız işler yüklenemedi" />;
}
