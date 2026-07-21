'use client';
import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Bookmark, BookmarkPlus, Loader2, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

/** GET /api/saved-views yanıt satırı (§14). query = kaydedilen URL query string. */
interface SavedView {
  id: string;
  page: string;
  name: string;
  query: string;
  createdAt: string;
}

/**
 * Kayıtlı görünümler menüsü (§14). Operatör mevcut tablo filtre/arama durumunu (URL query)
 * adlandırıp kaydeder, sonra tek tıkla geri yükler. Actor bazlıdır (API tarafı x-admin-actor
 * ile her admin'in yalnız kendi görünümlerini döndürür); self-contained + yeniden kullanılabilir.
 * `page` bu tablonun kimliğidir (ör. 'orders'); orders sayfası orkestrator tarafından bağlanır.
 */
export function SavedViewsMenu({ page }: { page: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [open, setOpen] = React.useState(false);
  const [views, setViews] = React.useState<SavedView[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // Mevcut URL query (leading '?' ile) — kaydedilecek/karşılaştırılacak durum.
  const currentQuery = searchParams.toString() ? `?${searchParams.toString()}` : '';

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/saved-views?page=${encodeURIComponent(page)}`, {
        cache: 'no-store',
      });
      setViews(res.ok ? ((await res.json()) as SavedView[]) : []);
    } catch {
      // Liste hatası menüyü kırmamalı — boş bırak.
      setViews([]);
    } finally {
      setLoading(false);
    }
  }, [page]);

  // Menü her açıldığında güncel listeyi çek (lazy).
  React.useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Görünümü uygula: filtreleri kaydedilen query ile değiştir.
  const restore = (view: SavedView) => {
    setOpen(false);
    router.push(`${pathname}${view.query}`);
  };

  // Mevcut durumu adlandırıp kaydet.
  const save = async () => {
    const name = window.prompt('Görünüm adı')?.trim();
    if (!name) return;
    setBusy(true);
    try {
      const res = await fetch('/api/saved-views', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page, name, query: currentQuery }),
      });
      if (res.ok) await load();
    } catch {
      /* yut: menü açık kalsın */
    } finally {
      setBusy(false);
    }
  };

  // Görünümü sil (yalnız kendi görünümü; API actor doğrular).
  const remove = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/saved-views?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (res.ok) setViews((prev) => prev.filter((v) => v.id !== id));
    } catch {
      /* yut */
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Bookmark />
          Görünümler
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Kayıtlı görünümler</DropdownMenuLabel>

        {loading ? (
          <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Yükleniyor…
          </div>
        ) : views.length === 0 ? (
          <div className="px-2.5 py-2 text-sm text-muted-foreground">Henüz kayıtlı görünüm yok.</div>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {views.map((view) => (
              <div
                key={view.id}
                className="flex items-center gap-1 rounded-sm pl-2.5 pr-1 hover:bg-accent hover:text-accent-foreground"
              >
                <button
                  type="button"
                  onClick={() => restore(view)}
                  className="flex-1 truncate py-1.5 text-left text-sm outline-none"
                  title={view.name}
                >
                  {view.name}
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  onClick={() => void remove(view.id)}
                  aria-label={`${view.name} görünümünü sil`}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}

        <DropdownMenuSeparator />
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4"
        >
          <BookmarkPlus />
          Bu görünümü kaydet
        </button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
