'use client';
import { ErrorState } from '../../components/ui/error-state';

/** Güvenlik route hata sınırı. Ortak gövde/redaksiyon: components/ui/error-state.tsx. */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} title="Güvenlik olayları yüklenemedi" />;
}
