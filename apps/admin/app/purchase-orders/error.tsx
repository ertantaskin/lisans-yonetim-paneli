'use client';
import { ErrorState } from '@/components/ui/error-state';

/**
 * Satın alma emirleri route hata sınırı. Ortak gövde/redaksiyon:
 * components/ui/error-state.tsx. (Bu dosya alias import stilini kullanır.)
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} title="Satın alma emirleri yüklenemedi" />;
}
