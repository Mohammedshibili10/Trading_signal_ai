'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronLeft, TrendingUp } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { InfoTip } from '@/components/ui/tooltip';
import { APP_NAME } from '@/lib/constants';
import { NAV } from '@/lib/nav';
import { cn } from '@/lib/utils';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { setMobileNavOpen, toggleSidebar } from '@/store/slices/ui-slice';

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const collapsed = useAppSelector((state) => state.ui.sidebarCollapsed);
  const role = useAppSelector((state) => state.auth.user?.role);

  return (
    <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-4">
      {NAV.map((group) => {
        const items = group.items.filter((item) => !item.adminOnly || role === 'ADMIN');
        if (items.length === 0) return null;

        return (
          <div key={group.label} className="flex flex-col gap-1">
            {!collapsed && (
              <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {group.label}
              </p>
            )}

            {items.map((item) => {
              // `startsWith` so /markets/RELIANCE keeps Markets highlighted,
              // but guard against /invest matching /investments-style prefixes.
              const active =
                pathname === item.href || pathname.startsWith(`${item.href}/`);
              const Icon = item.icon;

              const link = (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-primary/12 text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    collapsed && 'justify-center px-2',
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </Link>
              );

              return collapsed ? (
                <InfoTip key={item.href} content={item.label} side="right">
                  {link}
                </InfoTip>
              ) : (
                link
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

export function Sidebar() {
  const collapsed = useAppSelector((state) => state.ui.sidebarCollapsed);
  const dispatch = useAppDispatch();

  return (
    <aside
      className={cn(
        'hidden shrink-0 flex-col border-r border-border bg-card/40 transition-[width] duration-200 lg:flex',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      <div
        className={cn(
          'flex h-14 items-center gap-2 border-b border-border px-4',
          collapsed && 'justify-center px-2',
        )}
      >
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <TrendingUp className="size-4" />
        </div>
        {!collapsed && (
          <span className="truncate text-[15px] font-semibold tracking-tight">{APP_NAME}</span>
        )}
      </div>

      <SidebarContent />

      <div className="border-t border-border p-2">
        <Button
          variant="ghost"
          size={collapsed ? 'icon-sm' : 'sm'}
          onClick={() => dispatch(toggleSidebar())}
          className={cn('w-full text-muted-foreground', collapsed && 'w-auto')}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronLeft className={cn('size-4 transition-transform', collapsed && 'rotate-180')} />
          {!collapsed && <span className="text-[13px]">Collapse</span>}
        </Button>
      </div>
    </aside>
  );
}

/** Mobile drawer contents. Closes on navigation. */
export function MobileSidebar() {
  const dispatch = useAppDispatch();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <TrendingUp className="size-4" />
        </div>
        <span className="text-[15px] font-semibold tracking-tight">{APP_NAME}</span>
      </div>
      <SidebarContent onNavigate={() => dispatch(setMobileNavOpen(false))} />
    </div>
  );
}
