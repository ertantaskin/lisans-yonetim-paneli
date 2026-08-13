'use client';
import { ErrorState } from '../../../components/ui/error-state';

/**
 * Değişim fişleri route hata sınırı. Ortak gövde/redaksiyon: components/ui/error-state.tsx.
 * Bu sınır fiş DETAYINI (`claims/[id]`) da kapsar — başlık bu yüzden ikisine de uyacak
 * genellikte tutuldu.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} title="Değişim fişleri yüklenemedi" />;
}
