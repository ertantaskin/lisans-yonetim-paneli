'use client';
import { ErrorState } from '../components/ui/error-state';

/**
 * Kök hata sınırı. Tüm sunum + "üretimde redakte edilmiş mesajı gösterme" mantığı ortak
 * `ErrorState` bileşenindedir (components/ui/error-state.tsx) — 25 error.tsx'in aynı
 * deseni kopyalaması ve yalnız birinin Türkçe redaksiyon mantığını taşıması bu şekilde
 * bitti. Burada yalnız başlık verilir.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} title="Bir şeyler ters gitti" />;
}
