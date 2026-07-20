'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import { Search, CornerDownLeft } from 'lucide-react';
import { NAV } from './nav';

/** Ctrl/⌘+K komut paleti (§17). window 'open-command' olayıyla da açılır (topbar). */
export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
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

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const items = NAV.flatMap((s) => s.items.filter((i) => !i.soon));

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-ink/40 p-4 pt-[15vh] backdrop-blur-sm animate-in fade-in-0"
      onClick={() => setOpen(false)}
    >
      <Command
        className="w-full max-w-lg overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface-raised shadow-2xl animate-in zoom-in-95"
        onClick={(e) => e.stopPropagation()}
        loop
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 text-muted" />
          <Command.Input
            autoFocus
            placeholder="Komut ara veya sayfaya git…"
            className="h-11 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted/70"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">ESC</kbd>
        </div>
        <Command.List className="max-h-80 overflow-y-auto p-2">
          <Command.Empty className="py-6 text-center text-sm text-muted">
            Sonuç yok.
          </Command.Empty>
          <Command.Group
            heading="Sayfalar"
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted"
          >
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <Command.Item
                  key={item.href}
                  value={item.label}
                  onSelect={() => go(item.href)}
                  className="flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-sm text-ink/90 data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent"
                >
                  <Icon className="size-4" />
                  {item.label}
                  <CornerDownLeft className="ml-auto size-3 opacity-0 data-[selected=true]:opacity-60" />
                </Command.Item>
              );
            })}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
