import { Skeleton } from '../../components/ui/skeleton';

/** Denetim izi route yükleme iskeleti (sunucu ilk sayfayı çekerken). */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Yükleniyor">
      <div className="space-y-2">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-[32rem] max-w-full" />
      </div>
      <div className="flex flex-wrap gap-3">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-28" />
      </div>
      <Skeleton className="h-80 w-full rounded-xl" />
    </div>
  );
}
