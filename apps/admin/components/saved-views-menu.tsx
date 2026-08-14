'use client';
import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Bookmark, BookmarkPlus, Loader2, TriangleAlert, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { savedViewSaveNotice } from '../lib/saved-views';
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
 * Hata gövdesinden operatöre gösterilebilir tek satır çıkarır.
 * Proxy rotası API gövdesini olduğu gibi (metin ya da JSON) geçirir; ham JSON'u ekrana
 * dökmemek için `message` alanı varsa o kullanılır, yoksa kırpılmış düz metin.
 */
async function errorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  const body = raw.trim();
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
      const msg = parsed.message ?? parsed.error;
      if (typeof msg === 'string' && msg.trim()) return msg.trim();
    } catch {
      /* JSON değilse düz metne düş */
    }
  }
  return body.slice(0, 160) || `HTTP ${res.status}`;
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
 * DENETİM BULGUSU (U1) — uyarı ARTIK BOŞ-QUERY ŞARTINA BAĞLI DEĞİL: asıl tehlikeli durum
 * "adres dolu ama eksik"ti. Operatör `/customers?site=X` adresindeyken tabloya "acme" yazıp
 * görünümü kaydediyordu; adreste `?site=X` durduğu için HİÇ uyarı çıkmıyor, geri yüklediğinde
 * farklı bir liste geliyordu. Ekran, adrese YAZILMAYAN süzgeçlerini `unsyncedFilters` ile
 * bildirir; metin tek kaynaktan üretilir (`lib/saved-views.ts`, testli).
 *
 * KİŞİSEL: kayıtlar actor bazlıdır (API `x-admin-actor` ile yalnız isteği yapan admin'in
 * satırlarını döndürür/siler) — menüde de böyle yazar, operatör görünümünü "takıma bıraktım"
 * sanmasın.
 *
 * `page` bu ekranın kimliğidir (ör. 'orders', 'stock'): görünümler ekranlar arası karışmaz.
 */
export interface SavedViewsMenuProps {
  page: string;
  /**
   * Bu ekranda adrese YAZILMAYAN süzgeçlerin insan-okur adı. Verilirse kaydetme onayında
   * ve menüde kalıcı uyarı çıkar. Ekranın tüm süzgeçleri URL'de yaşıyorsa GEÇİLMEZ
   * (/orders, /stock, /customers → `DataTable syncUrl` ile yazılıyor).
   */
  unsyncedFilters?: string;
}

export function SavedViewsMenu({ page, unsyncedFilters }: SavedViewsMenuProps) {
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
      <SavedViewsMenuInner page={page} unsyncedFilters={unsyncedFilters} />
    </React.Suspense>
  );
}

function SavedViewsMenuInner({ page, unsyncedFilters }: SavedViewsMenuProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [open, setOpen] = React.useState(false);
  const [views, setViews] = React.useState<SavedView[]>([]);
  const [loading, setLoading] = React.useState(false);
  /**
   * Liste ALINAMADI (veri YOK ile aynı şey değil). Eskiden hata da boş dizi ile
   * karşılanıyordu → menü "Henüz kayıtlı görünüm yok." diyordu; operatör kayıtlarının
   * silindiğini sanabilirdi ve "kaydet" düğmesine basıp aynı adı ikinci kez oluştururdu.
   * (Komşu /deployments ekranı bu ayrımı doğru yapıyor; desen oradan alındı.)
   */
  const [loadError, setLoadError] = React.useState<string | null>(null);
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
      if (!res.ok) {
        setLoadError(await errorText(res));
        return;
      }
      setViews((await res.json()) as SavedView[]);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Bağlantı hatası');
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
    // Metin TEK KAYNAK (lib/saved-views.ts): uyarı artık boş-query şartından bağımsız —
    // adres dolu ama tablo içi süzgeçler yazılmıyorsa da basılır (bulgu U1).
    const notice = savedViewSaveNotice({ hasQuery: Boolean(currentQuery), unsyncedFilters });
    const answer = await confirm({
      title: 'Bu görünümü kaydet',
      description: notice.description,
      details: notice.details.length > 0 ? notice.details : undefined,
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
      // SESSİZ BAŞARISIZLIK YASAK: eskiden 4xx/5xx tamamen yutuluyordu ve menü "kaydettim"
      // görüntüsü veriyordu (liste yenilenmediği için fark bile edilmiyordu).
      if (!res.ok) {
        toast.error(`Görünüm kaydedilemedi: ${await errorText(res)}`);
        return;
      }
      toast.success(`“${name}” görünümü kaydedildi.`);
      await load();
    } catch (e) {
      toast.error(
        `Görünüm kaydedilemedi: ${e instanceof Error ? e.message : 'Bağlantı hatası'}`,
      );
    } finally {
      setBusy(false);
    }
  };

  // Görünümü sil (yalnız kendi görünümü; API actor doğrular).
  const remove = async (id: string, name: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/saved-views?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        // Satırı listeden DÜŞÜRME: silinmediği hâlde kaybolursa operatör sildiğini sanır.
        toast.error(`Görünüm silinemedi: ${await errorText(res)}`);
        return;
      }
      setViews((prev) => prev.filter((v) => v.id !== id));
      toast.success(`“${name}” görünümü silindi.`);
    } catch (e) {
      toast.error(`Görünüm silinemedi: ${e instanceof Error ? e.message : 'Bağlantı hatası'}`);
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
        {/* Ekranın adrese yazılmayan süzgeçleri varsa uyarı KALICI: operatör kaydetmeye
            karar vermeden önce görsün (onay modalinde de tekrar edilir). */}
        {unsyncedFilters && (
          // Ton/renk TEK KAYNAK: rozet `warning` varyantıyla birebir aynı token çifti
          // (`--warning-fill` + `--warning-ring`) — yeni hue eklenmez.
          <p className="mx-2.5 mb-1.5 flex gap-1.5 rounded-md bg-(--warning-fill) px-2 py-1.5 text-xs leading-snug text-warning ring-1 ring-inset ring-(--warning-ring)">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>Bu ekranda {unsyncedFilters} adrese yazılmaz — görünüme dahil edilmez.</span>
          </p>
        )}

        {loading ? (
          <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Yükleniyor…
          </div>
        ) : loadError ? (
          // "Veri YOK" ile "veri ALINAMADI" ayrı gösterilir (projedeki dürüstlük kuralı).
          <div className="px-2.5 py-2 text-sm">
            <p className="text-destructive">Kayıtlı görünümler alınamadı: {loadError}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-1 rounded-sm text-xs text-foreground underline underline-offset-4 hover:no-underline"
            >
              Tekrar dene
            </button>
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
                  onClick={() => void remove(view.id, view.name)}
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
