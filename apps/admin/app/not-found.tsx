import Link from 'next/link';
import { Home } from 'lucide-react';
import { Button } from '../components/ui/button';

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
      <p className="text-6xl font-semibold tracking-tight text-muted-foreground/60">404</p>
      <h1 className="text-lg font-semibold text-foreground">Sayfa bulunamadı</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Aradığın sayfa taşınmış veya hiç var olmamış olabilir.
      </p>
      <Button asChild variant="outline" className="mt-2">
        <Link href="/">
          <Home /> Panele dön
        </Link>
      </Button>
    </div>
  );
}
