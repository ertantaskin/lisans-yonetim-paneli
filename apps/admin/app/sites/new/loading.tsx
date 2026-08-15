import { Skeleton } from '../../../components/ui/skeleton';

/** Site bağlama sihirbazı yükleme iskeleti (owner kontrolü + sunucu veri çekimi sırasında). */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Yükleniyor">
      <Skeleton className="h-8 w-24" />
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      {/* 3 adımlı sihirbaz gövdesi. */}
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  );
}
