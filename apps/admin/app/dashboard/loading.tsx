import { Skeleton } from '../../components/ui/skeleton';

/**
 * Genel-bakış (iş istasyonu) route yükleme iskeleti — sunucu özeti çekilirken gösterilir.
 * Yerleşim gerçek sayfayla BİREBİR aynı sırada: canlı sayaç şeridi → iki akış kartı →
 * ince metrik şeridi → hızlı erişim (böylece veri gelince ekran zıplamaz).
 */
export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Yükleniyor">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-8 w-56 rounded-md" />
      </div>

      {/* Canlı KPI şeridi */}
      <Skeleton className="h-[52px] w-full rounded-xl" />

      {/* İki canlı akış kartı */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Skeleton className="h-[26rem] w-full rounded-xl" />
        <Skeleton className="h-[26rem] w-full rounded-xl" />
      </div>

      {/* Yavaş metrik şeridi + hızlı erişim */}
      <Skeleton className="h-10 w-full rounded-lg" />
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-36 rounded-md" />
        ))}
      </div>
    </div>
  );
}
