'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { cn } from '../../lib/utils';
import { NAV } from './nav';
import { Badge } from '../ui/badge';

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-surface-raised/60 backdrop-blur md:flex">
      {/* Marka */}
      <div className="flex h-16 items-center gap-2.5 px-5">
        <span className="flex size-8 items-center justify-center rounded-[var(--radius-md)] bg-accent text-white shadow-sm">
          <KeyRound className="size-4.5" />
        </span>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-ink">Lisans Paneli</div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted">
            Tedarik & Yönetim
          </div>
        </div>
      </div>

      {/* Menü */}
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
        {NAV.map((section) => (
          <div key={section.title}>
            <div className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted/80">
              {section.title}
            </div>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = !item.soon && (pathname === item.href || pathname.startsWith(item.href + '/'));
                const Icon = item.icon;
                const content = (
                  <span
                    className={cn(
                      'group relative flex items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-2 text-sm font-medium transition-colors',
                      active
                        ? 'bg-accent-soft text-accent'
                        : item.soon
                          ? 'cursor-default text-muted/60'
                          : 'text-ink/75 hover:bg-ink/[0.05] hover:text-ink',
                    )}
                  >
                    {active && (
                      <span className="absolute -left-3 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-accent" />
                    )}
                    <Icon className="size-4.5 shrink-0" />
                    <span className="truncate">{item.label}</span>
                    {item.soon && (
                      <Badge variant="outline" className="ml-auto px-1.5 py-0 text-[9px]">
                        yakında
                      </Badge>
                    )}
                  </span>
                );
                return (
                  <li key={item.label}>
                    {item.soon ? content : <Link href={item.href}>{content}</Link>}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Alt bilgi */}
      <div className="border-t border-border px-4 py-3 text-[11px] text-muted">
        <div className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-success" />
          Sistem çalışıyor
        </div>
      </div>
    </aside>
  );
}
