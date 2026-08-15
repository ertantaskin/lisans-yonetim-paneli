'use client';
import { ErrorState } from '../../../components/ui/error-state';

/** Site bağlama sihirbazı hata sınırı. Ortak gövde/redaksiyon: components/ui/error-state.tsx. */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} title="Site sihirbazı açılamadı" />;
}
