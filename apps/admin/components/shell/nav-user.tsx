'use client';
import { ChevronsUpDown, LogOut, Sun, Moon, BadgeCheck } from 'lucide-react';
import { useTheme } from 'next-themes';
import type { LucideIcon } from 'lucide-react';
import { Avatar, AvatarFallback, initials } from '../ui/avatar';
import { SidebarMenuButton, useSidebar } from '../ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

type User = { name: string; email: string; icon?: LucideIcon };

/** Kenar menü footer — kullanıcı + hesap menüsü (shadcn-admin deseni). */
export function NavUser({ user }: { user: User }) {
  const { isMobile } = useSidebar();
  const { setTheme, resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
        >
          <Avatar className="size-8 rounded-lg">
            <AvatarFallback>{initials(user.name)}</AvatarFallback>
          </Avatar>
          <span className="grid flex-1 text-left leading-tight">
            <span className="truncate text-sm font-medium">{user.name}</span>
            <span className="truncate text-[11px] text-sidebar-foreground/60">{user.email}</span>
          </span>
          <ChevronsUpDown className="ml-auto size-4 opacity-70" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
        side={isMobile ? 'bottom' : 'right'}
        align="end"
        sideOffset={4}
      >
        <DropdownMenuLabel className="normal-case">
          <div className="flex items-center gap-2 py-1">
            <Avatar className="size-8 rounded-lg">
              <AvatarFallback>{initials(user.name)}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left leading-tight">
              <span className="truncate text-sm font-medium text-foreground">{user.name}</span>
              <span className="truncate text-[11px] text-muted-foreground">{user.email}</span>
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem>
            <BadgeCheck />
            Hesap
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme(isDark ? 'light' : 'dark')}>
            {isDark ? <Sun /> : <Moon />}
            {isDark ? 'Açık tema' : 'Koyu tema'}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive focus:text-destructive">
          <LogOut />
          Çıkış
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
