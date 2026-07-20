import { Skeleton } from '@/components/ui/skeleton';

/** Tedarikçiler route yükleme iskeleti. */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Yükleniyor">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-40 w-full max-w-2xl rounded-xl" />
      <div className="space-y-2">
        <Skeleton className="h-9 w-full max-w-sm" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    </div>
  );
}
