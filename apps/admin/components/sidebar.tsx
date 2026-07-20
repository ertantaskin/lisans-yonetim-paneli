'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/pending', label: 'Bekleyen Teslimatlar', icon: '📦' },
  { href: '/orders', label: 'Siparişler', icon: '🧾' },
  { href: '/stock', label: 'Stok & Ürünler', icon: '🔑' },
  { href: '/sites', label: 'Siteler', icon: '🌐' },
];

export function Sidebar() {
  const path = usePathname();
  return (
    <aside className="flex w-60 shrink-0 flex-col gap-1 border-r border-ink/10 bg-surface-raised p-4">
      <div className="mb-6 flex items-center gap-2 px-2">
        <span className="grid size-8 place-items-center rounded-lg bg-accent text-sm font-bold text-white">
          J
        </span>
        <span className="text-lg font-semibold text-ink">Jetlisans</span>
      </div>
      <nav className="flex flex-col gap-1">
        {NAV.map((n) => {
          const active = path === n.href || path.startsWith(n.href + '/');
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                active
                  ? 'bg-accent-soft font-medium text-accent'
                  : 'text-ink/70 hover:bg-accent-soft/50 hover:text-ink'
              }`}
            >
              <span aria-hidden>{n.icon}</span>
              {n.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto px-3 pt-4 text-xs text-ink/30">Faz 1 · MVP</div>
    </aside>
  );
}
