'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { Eye, EyeOff, LogOut, Menu, Moon, Search, Settings, Sun, User } from 'lucide-react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, SheetContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InfoTip } from '@/components/ui/tooltip';
import { endpoints } from '@/lib/api';
import { initials, timeToNextOpen } from '@/lib/format';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { setCommandPaletteOpen, setMobileNavOpen, togglePrivacyMode } from '@/store/slices/ui-slice';
import { MobileSidebar } from './sidebar';
import { CommandPalette } from './command-palette';

export function Topbar() {
  const dispatch = useAppDispatch();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  const user = useAppSelector((state) => state.auth.user);
  const mobileNavOpen = useAppSelector((state) => state.ui.mobileNavOpen);
  const privacyMode = useAppSelector((state) => state.ui.privacyMode);

  // Theme can only be read after mount — rendering the icon before that
  // produces a hydration mismatch.
  useEffect(() => setMounted(true), []);

  // Cmd/Ctrl-K opens search from anywhere.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        dispatch(setCommandPaletteOpen(true));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch]);

  const { data: marketStatus } = useQuery({
    queryKey: ['market-status'],
    queryFn: async () => (await endpoints.market.status()).data,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const equityOpen = marketStatus?.equity?.isOpen ?? false;

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/85 px-3 backdrop-blur-md sm:px-4">
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          onClick={() => dispatch(setMobileNavOpen(true))}
          aria-label="Open navigation"
        >
          <Menu className="size-4" />
        </Button>

        <button
          type="button"
          onClick={() => dispatch(setCommandPaletteOpen(true))}
          className="flex h-9 flex-1 items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 text-left text-[13px] text-muted-foreground transition-colors hover:bg-muted sm:max-w-md"
        >
          <Search className="size-4 shrink-0" />
          <span className="truncate">Search stocks, forex, crypto…</span>
          <kbd className="ml-auto hidden shrink-0 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] sm:inline">
            ⌘K
          </kbd>
        </button>

        <div className="ml-auto flex items-center gap-1">
          {/* Market clock — the single most useful ambient signal on the page. */}
          <InfoTip
            content={
              equityOpen
                ? 'NSE and BSE are open until 15:30 IST'
                : `NSE opens in ${timeToNextOpen()}`
            }
          >
            <Badge variant={equityOpen ? 'bull' : 'secondary'} className="hidden sm:inline-flex">
              <span
                className={`size-1.5 rounded-full ${equityOpen ? 'bg-bull' : 'bg-muted-foreground'}`}
              />
              {equityOpen ? 'NSE open' : 'NSE closed'}
            </Badge>
          </InfoTip>

          <InfoTip content={privacyMode ? 'Show amounts' : 'Hide amounts (for screen sharing)'}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => dispatch(togglePrivacyMode())}
              aria-label={privacyMode ? 'Show amounts' : 'Hide amounts'}
            >
              {privacyMode ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </Button>
          </InfoTip>

          <InfoTip content="Toggle theme">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle theme"
            >
              {mounted && theme === 'dark' ? (
                <Sun className="size-4" />
              ) : (
                <Moon className="size-4" />
              )}
            </Button>
          </InfoTip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="ml-1" aria-label="Account">
                <Avatar className="size-7">
                  {user?.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
                  <AvatarFallback>{user ? initials(user.name) : <User className="size-3.5" />}</AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-56">
              {user && (
                <>
                  <DropdownMenuLabel className="normal-case tracking-normal">
                    <p className="text-[13px] font-medium text-foreground">{user.name}</p>
                    <p className="truncate text-xs font-normal text-muted-foreground">{user.email}</p>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onClick={() => router.push('/settings')}>
                <Settings /> Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                destructive
                onClick={async () => {
                  await endpoints.auth.logout().catch(() => undefined);
                  router.push('/login');
                }}
              >
                <LogOut /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <Dialog open={mobileNavOpen} onOpenChange={(open) => dispatch(setMobileNavOpen(open))}>
        <SheetContent side="left" className="p-0">
          <MobileSidebar />
        </SheetContent>
      </Dialog>

      <CommandPalette />
    </>
  );
}
