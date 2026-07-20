'use client';
import { RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '../../components/ui/button';

/** Ayarlar route hata sınırı. */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--destructive)_12%,transparent)] text-destructive">
        <TriangleAlert className="size-6" />
      </span>
      <h1 className="text-lg font-semibold text-foreground">Ayarlar yüklenemedi</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {error.message || 'Beklenmeyen bir hata oluştu.'}
      </p>
      <Button onClick={reset} variant="outline" className="mt-2">
        <RotateCw /> Tekrar dene
      </Button>
    </div>
  );
}
