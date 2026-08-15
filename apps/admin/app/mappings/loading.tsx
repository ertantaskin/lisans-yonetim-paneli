import { Skeleton } from '../../components/ui/skeleton';

/** Ürün Eşleştirme route yükleme iskeleti (sunucu veri çekimi sırasında). */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Yükleniyor">
      <div className="space-y-2">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-4 w-[32rem] max-w-full" />
      </div>
      {/* İki bölüm: site kataloğu + eşlenmemiş gelen ürünler. */}
      <Skeleton className="h-9 w-full max-w-sm" />
      <Skeleton className="h-64 w-full rounded-lg" />
      <Skeleton className="h-48 w-full rounded-lg" />
    </div>
  );
}
