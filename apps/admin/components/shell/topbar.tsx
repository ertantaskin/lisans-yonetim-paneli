'use client';
import { Search } from 'lucide-react';
import { ThemeToggle } from '../theme';
import { Badge } from '../ui/badge';

/** Üst bar: Ctrl+K arama tetiği + ortam rozeti + tema toggle (§17). */
export function Topbar() {
  return (
    <header className="sticky top-0 z-40 flex h-16 items-center gap-3 border-b border-border bg-surface/80 px-5 backdrop-blur-md md:px-8">
      {/* Ctrl+K arama tetiği */}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event('open-command'))}
        className="group flex h-9 w-full max-w-sm items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface-raised px-3 text-sm text-muted shadow-sm transition-colors hover:border-accent/40"
      >
        <Search className="size-4" />
        <span className="flex-1 text-left">Ara — sipariş, e-posta, key…</span>
        <kbd className="hidden items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted sm:inline-flex">
          Ctrl K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-2">
        <Badge variant="success" className="hidden sm:inline-flex">
          <span className="size-1.5 rounded-full bg-current" />
          CANLI
        </Badge>
        <ThemeToggle />
      </div>
    </header>
  );
}
