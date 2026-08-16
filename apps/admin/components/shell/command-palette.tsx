'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import { Search, CornerDownLeft, ShoppingCart, KeyRound } from 'lucide-react';
import { NAV } from './nav';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { orderStatusLabel } from '../../lib/labels';
import { includesTr } from '../../lib/utils';

/** GET /api/search yanıtı (server-taraflı proxy; ADMIN_TOKEN sızmaz). */
interface SearchOrderHit {
  id: string;
  remoteOrderId: string;
  customerEmail: string;
  status: string;
}
interface SearchKeyHit {
  licenseItemId: string;
  productSku: string;
  orderId: string | null;
  masked: string;
}
interface SearchResult {
  orders: SearchOrderHit[];
  keys: SearchKeyHit[];
}

const EMPTY: SearchResult = { orders: [], keys: [] };

/** Ctrl/⌘+K komut paleti (§17). window 'open-command' olayıyla da açılır (topbar).
 *  Statik sayfa komutlarına ek olarak canlı global arama (§13): yazınca sunucu
 *  proxy'sine (debounce) GET /api/search?q= — sipariş + maskeli key sonuçları gruplu. */
export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<SearchResult>(EMPTY);
  /** Arama ÇALIŞTIRILAMADIYSA sebep — "sonuç yok" ile karıştırılmaz (bkz. fetch bloğu). */
  const [searchError, setSearchError] = React.useState<string | null>(null);
  const router = useRouter();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Kısayol DEĞİŞMEDİ: yalnız `open` durumunu çevirir.
      // Escape dalı KALDIRILDI: palet artık gerçek bir Dialog (Radix) — Escape'i,
      // dışarı tıklamayı, gövde kaydırma kilidini ve odağı Radix yönetiyor. Global
      // dinleyicide tutmak, panelin BAŞKA katmanlarındaki Escape'i de yutuyordu.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('open-command', onOpen);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('open-command', onOpen);
    };
  }, []);

  // Kapanışta durumu sıfırla (bir sonraki açılışta eski sonuç görünmesin).
  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setResults(EMPTY);
      setSearchError(null);
    }
  }, [open]);

  // Debounce'lu canlı arama. En son isteğin kazanması için AbortController + guard.
  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(EMPTY);
      setSearchError(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      /*
       * HATA "SONUÇ YOK"A DÖNÜŞMEZ (denetim): proxy artık non-2xx durumu KORUYARAK döner
       * (`app/api/search/route.ts`). Başarısız aramayı boş sonuç gibi göstermek operatöre
       * "aradığın sipariş/anahtar YOK" dedirtirdi — bu panelde sessiz boş listenin daha
       * önce ürettiği yanılgının aynısı. Palet yine kırılmaz: sonuçlar boş kalır, sebebi
       * boş-durum bloğunda yazılır. AbortError (yeni tuş vuruşu) hata DEĞİLDİR.
       */
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then(async (r) => {
          if (!r.ok) {
            const body = (await r.json().catch(() => null)) as { message?: string } | null;
            throw new Error(body?.message || `Arama başarısız (sunucu ${r.status})`);
          }
          return (await r.json()) as SearchResult;
        })
        .then((data) => {
          setResults(data ?? EMPTY);
          setSearchError(null);
        })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          setResults(EMPTY);
          setSearchError(e instanceof Error ? e.message : 'Arama yapılamadı');
        });
    }, 220);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  // Statik sayfalar (mevcut davranış korunur). shouldFilter=false olduğundan burada
  // elle filtreleriz; sunucu sonuçları ise zaten sunucuda filtrelenmiştir.
  // Türkçe-duyarlı karşılaştırma (`includesTr`): ham `toLowerCase()` ile "İ"/"I" içeren
  // sayfa adları ("İnceleme", "Siparişler") sessizce bulunamıyordu. `includesTr` artık
  // tr-TR VE nötr katlamayı birlikte dener → "ai" yazınca "AI Operasyon" da bulunur
  // (tek başına tr-TR katlaması onu 'aı operasyon' yapıp gizliyordu). Boş sorguda
  // `includesTr` true döner → tüm sayfalar listelenir (eski davranış birebir).
  const pages = NAV.flatMap((s) => s.items.filter((i) => !i.soon));
  const filteredPages = pages.filter((i) => includesTr(i.label, query));

  const { orders, keys } = results;

  /*
   * Palet artık GERÇEK bir modal: elle kurulmuş overlay `role="dialog"`/`aria-modal`
   * taşımıyordu, Tab arka plandaki sidebar linklerine kaçıyordu, kapanışta odak
   * tetikleyiciye geri verilmiyordu ve gövde kaydırması kilitlenmiyordu. `DialogContent`
   * bunların hepsini (odak tuzağı + Escape + dışarı tıklama + scroll kilidi + odak iadesi)
   * hazır getirir; ad-hoc `z-[100]` de düşer (dialog katmanı z-50).
   * Arama/gezinme davranışı ve Ctrl+K kısayolu DEĞİŞMEDİ.
   */
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        hideClose
        /* Radix erişilebilir ad ister; palet görsel başlık taşımaz → sr-only başlık.
           `aria-describedby={undefined}`: açıklama yok, Radix'in kırık referans uyarısı çıkmasın. */
        aria-describedby={undefined}
        /* Yerleşim ezmeleri (twMerge aynı grupta çözer): dikey ortalama yerine üstten
           %15 (eski görünüm birebir), dolgu/boşluk yok — gövdeyi Command çiziyor. */
        className="top-[15vh] translate-y-0 gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">Komut paleti</DialogTitle>
        <Command className="w-full overflow-hidden bg-transparent" shouldFilter={false} loop>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 text-muted-foreground" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Sayfa, sipariş no, e-posta veya key son-5 hane…"
              className="h-11 flex-1 bg-transparent text-sm text-popover-foreground outline-none placeholder:text-muted-foreground/70"
            />
            <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">ESC</kbd>
          </div>
          <Command.List className="max-h-80 overflow-y-auto p-2">
            {/*
              DÜRÜSTLÜK DÜZELTMESİ (denetim bulgusu): anahtar araması sessizce EN AZ 3 RAKAM
              ister — search/search.service.ts:96-98 `digitCount < 3` ise sorguyu hiç
              çalıştırmadan boş döner (yanlış eşleşme gürültüsünü kesen bilinçli kapı). Harf
              ağırlıklı bir son-5 hane arayan operatör yalnız "Sonuç yok." görüyor, hata
              almıyordu → "bu anahtar panelde kayıtlı değil" yanılgısı. Kısıt artık boş
              durumda yazılı (kod kapısına dokunulmadı).
            */}
            {/*
              HATA BANDI — `Command.Empty` İÇİNE KONULAMAZ: cmdk onu yalnız HİÇ öğe
              render edilmediğinde gösterir; sorgu bir sayfa adıyla eşleştiğinde (çok sık)
              liste dolu olur ve hata GİZLENİRDİ. Bu yüzden ayrı, koşulsuz bir satır.
            */}
            {searchError && (
              <div
                role="status"
                className="mb-1 rounded-sm border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
              >
                <strong className="font-medium">Sipariş/anahtar araması yapılamadı:</strong>{' '}
                {searchError} — aşağıdaki sayfa listesi çalışmaya devam ediyor. Sonuç
                görünmemesi, aradığınız kaydın OLMADIĞI anlamına gelmez.
              </div>
            )}

            <Command.Empty className="space-y-1 py-6 text-center text-sm text-muted-foreground">
              <p>Sonuç yok.</p>
              <p className="text-xs">
                Anahtar araması için yazdığınız metinde <strong>en az 3 rakam</strong> olmalıdır;
                harf ağırlıklı son-5 hane burada sonuç döndürmez. Tam anahtarla aramak için
                Envanter ekranını kullanın.
              </p>
            </Command.Empty>

            {filteredPages.length > 0 && (
              <Command.Group
                heading="Sayfalar"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {filteredPages.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Command.Item
                      key={item.href}
                      value={`page:${item.href}`}
                      onSelect={() => go(item.href)}
                      className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm text-popover-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                    >
                      <Icon className="size-4" />
                      {item.label}
                      <CornerDownLeft className="ml-auto size-3 opacity-0 data-[selected=true]:opacity-60" />
                    </Command.Item>
                  );
                })}
              </Command.Group>
            )}

            {orders.length > 0 && (
              <Command.Group
                heading="Siparişler"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {orders.map((o) => (
                  <Command.Item
                    key={o.id}
                    value={`order:${o.id}`}
                    onSelect={() => go(`/orders/${o.id}`)}
                    className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm text-popover-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                  >
                    <ShoppingCart className="size-4 shrink-0" />
                    <span className="font-medium">#{o.remoteOrderId}</span>
                    <span className="truncate text-muted-foreground">{o.customerEmail}</span>
                    <span className="ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {orderStatusLabel(o.status)}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {keys.length > 0 && (
              <Command.Group
                heading="Key'ler"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {keys.map((k) => (
                  <Command.Item
                    key={k.licenseItemId}
                    value={`key:${k.licenseItemId}`}
                    onSelect={() => go(k.orderId ? `/orders/${k.orderId}` : '/stock')}
                    className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm text-popover-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                  >
                    <KeyRound className="size-4 shrink-0" />
                    <span className="font-mono text-xs">{k.masked}</span>
                    <span className="truncate text-muted-foreground">{k.productSku}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                      {k.orderId ? 'siparişte' : 'stokta'}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
