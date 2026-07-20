'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import { Search, CornerDownLeft, ShoppingCart, KeyRound } from 'lucide-react';
import { NAV } from './nav';

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
  const router = useRouter();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
    }
  }, [open]);

  // Debounce'lu canlı arama. En son isteğin kazanması için AbortController + guard.
  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(EMPTY);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? (r.json() as Promise<SearchResult>) : EMPTY))
        .then((data) => setResults(data ?? EMPTY))
        .catch(() => {
          /* iptal/hata: paleti kırma */
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
  const pages = NAV.flatMap((s) => s.items.filter((i) => !i.soon));
  const ql = query.trim().toLowerCase();
  const filteredPages = ql ? pages.filter((i) => i.label.toLowerCase().includes(ql)) : pages;

  const { orders, keys } = results;

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 p-4 pt-[15vh] backdrop-blur-sm animate-in fade-in-0"
      onClick={() => setOpen(false)}
    >
      <Command
        className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl animate-in zoom-in-95"
        onClick={(e) => e.stopPropagation()}
        shouldFilter={false}
        loop
      >
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
          <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
            Sonuç yok.
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
                  <span className="ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                    {o.status}
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
    </div>
  );
}
