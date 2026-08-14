'use client';
import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Bookmark, BookmarkPlus, Loader2, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { useConfirm } from './ui/confirm';
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
 * adlandırıp kaydeder, sonra tek tıkla geri yükler.
 *
 * SERİLEŞTİRME SÖZLEŞMESİ (bağlamadan ÖNCE okunmalı): kaydedilen şey ADRES ÇUBUĞUNDAKİ query
 * string'in TAMAMIDIR. Yani bu bileşen YALNIZ süzgeçleri URL'de yaşayan ekranlarda anlamlıdır.
 * İki yol da geçerlidir:
 *   (a) sayfanın KENDİ sunucu parametreleri (`?site=`, `?status=`… — /stock, /customers,
 *       /mappings, /quarantine/records),
 *   (b) `DataTable syncUrl` — arama/facet/sıralamayı `tq`/`tf.<kolon>`/`tsort` anahtarlarıyla
 *       adrese yazar (bkz. data-table/url-state.ts; /orders bunu kullanır).
 * Süzgeçlerini yalnız istemci state'inde tutan (syncUrl KAPALI) bir tabloya bağlanırsa
 * kaydedilen görünüm BOŞ olur ve geri yükleme hiçbir şey yapmaz. Bu yüzden menü boş query'de
 * SUSMAZ, açıkça uyarır (aşağıya bkz.) — sessizce işe yaramaz bir kayıt üretmek, bu panelde
 * en tehlikeli kusur sınıfıdır ("yaptım sanıp yapmamak").
 *
 * KİŞİSEL: kayıtlar actor bazlıdır (API `x-admin-actor` ile yalnız isteği yapan admin'in
 * satırlarını döndürür/siler) — menüde de böyle yazar, operatör görünümünü "takıma bıraktım"
 * sanmasın.
 *
 * `page` bu ekranın kimliğidir (ör. 'orders', 'stock'): görünümler ekranlar arası karışmaz.
 */
export function SavedViewsMenu({ page }: { page: string }) {
  /*
   * SUSPENSE SINIRI: `useSearchParams()` bir CSR-bailout kancasıdır; sarmalanmadığında
   * statik prerender edilen bir rotada `next build` HATA verir. Bu menü artık birden çok
   * ekrana bağlanıyor ve hepsinin `force-dynamic` kalacağının garantisi yok → sınır burada,
   * bileşenin İÇİNDE kuruldu (her çağıranın hatırlaması gereken bir kural bırakmamak için).
   */
  return (
    <React.Suspense
      fallback={
        <Button variant="outline" size="sm" disabled>
          <Bookmark />
          Görünümler
        </Button>
      }
    >
      <SavedViewsMenuInner page={page} />
    </React.Suspense>
  );
}

function SavedViewsMenuInner({ page }: { page: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [open, setOpen] = React.useState(false);
  const [views, setViews] = React.useState<SavedView[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const { confirm, dialog } = useConfirm();

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

  /*
   * Görünümü uygula: filtreleri kaydedilen query ile değiştir.
   *
   * TAM GEZİNME (router.push DEĞİL) — bilinçli: bazı ekranlarda süzgeçler sunucu
   * parametresidir, bazılarında `DataTable`ın URL senkronudur (bkz. data-table/url-state.ts).
   * İkincisi durumu YALNIZ mount'ta okur; yumuşak gezinme aynı rotada bileşeni yeniden
   * kurmadığı için adres değişir ama tablo süzgeçleri UYGULANMAZDI ("geri yükledim sanıp
   * yüklememek"). Tam gezinme her iki sınıfta da tek bir doğru davranış verir; görünüm
   * yükleme nadir ve bilinçli bir işlem olduğu için ek sayfa yüklemesi kabul edilebilir.
   */
  const restore = (view: SavedView) => {
    setOpen(false);
    window.location.assign(`${pathname}${view.query}`);
  };

  // Mevcut durumu adlandırıp kaydet.
  const save = async () => {
    // Menü ÖNCE kapanır: modal, açık bir dropdown'ın içinden değil temiz bir zeminden açılsın.
    setOpen(false);
    const answer = await confirm({
      title: 'Bu görünümü kaydet',
      description: currentQuery
        ? 'Adres çubuğundaki süzgeç durumu bu adla kaydedilir; menüden tek tıkla geri dönebilirsiniz. Görünüm yalnız size görünür.'
        : // DÜRÜSTLÜK: adres çubuğunda hiç süzgeç yokken kaydedilen görünüm sayfayı SÜZGEÇSİZ
          // açar. Kaydı engellemiyoruz (bir ekranın "varsayılan hâli" de meşru bir görünümdür),
          // ama operatör ne kaydettiğini bilerek onaylasın.
          'DİKKAT: Adres çubuğunda şu an hiçbir süzgeç yok — bu görünüm sayfayı süzgeçsiz açar. Bu ekranın bazı süzgeçleri (tablo içi arama/facet) adrese yazılmadığı için kaydedilemez.',
      confirmLabel: 'Kaydet',
      reason: {
        label: 'Görünüm adı',
        inputType: 'text',
        required: true,
        placeholder: 'ör. Bekleyen · Acme sitesi',
      },
    });
    const name = answer?.reason.trim();
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
    <>
    {dialog}
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Bookmark />
          Görünümler
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Kayıtlı görünümler</DropdownMenuLabel>
        {/* KİŞİSEL KAPSAM görünür yazılır: kayıtlar actor bazlı, başka admin'ler göremez. */}
        <p className="px-2.5 pb-1.5 text-xs leading-snug text-muted-foreground">
          Yalnız size görünür — bu ekrandaki süzgeçlerin adres çubuğuna yazılan hâlini saklar.
        </p>

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
    </>
  );
}
