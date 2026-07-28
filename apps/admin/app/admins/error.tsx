'use client';
import { ErrorState } from '../../components/ui/error-state';

/**
 * Yöneticiler route hata sınırı. Gövde + "üretimde redakte edilmiş mesaj yerine Türkçe
 * genel metin + hata kodu" mantığı ortak `ErrorState` bileşenindedir
 * (components/ui/error-state.tsx); burada yalnız route'a özel başlık verilir.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} title="Yöneticiler yüklenemedi" />;
}
