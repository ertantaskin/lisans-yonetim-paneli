import { Skeleton } from '../../../components/ui/skeleton';

/** Hesap Güvenliğim (2FA) route yükleme iskeleti (sunucu veri çekimi sırasında). */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Yükleniyor">
      <div className="space-y-2">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-56 w-full rounded-xl" />
    </div>
  );
}
