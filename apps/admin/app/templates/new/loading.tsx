import { Skeleton } from '../../../components/ui/skeleton';

/** Yeni şablon formu yükleme iskeleti (site/ürün seçenekleri çekilirken). */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Yükleniyor">
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-[28rem] w-full rounded-xl" />
    </div>
  );
}
