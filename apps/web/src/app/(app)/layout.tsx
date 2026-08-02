'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { Skeleton } from '@/components/ui/skeleton';
import { endpoints, setAccessToken, setUnauthorisedHandler } from '@/lib/api';
import { DISCLAIMER } from '@/lib/constants';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { authLoading, setCredentials, signedOut } from '@/store/slices/auth-slice';
import type { User } from '@/types';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const status = useAppSelector((state) => state.auth.status);

  // A failed refresh anywhere in the app lands here.
  useEffect(() => {
    setUnauthorisedHandler(() => {
      dispatch(signedOut());
      router.replace('/login');
    });
  }, [dispatch, router]);

  /**
   * Bootstrap the session.
   *
   * The access token is in memory only, so a page reload always starts without
   * one. `/auth/refresh` exchanges the httpOnly cookie for a fresh pair — this
   * is what makes "stay signed in" work without ever exposing a long-lived
   * credential to JavaScript.
   */
  const { isLoading, isError } = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      dispatch(authLoading());
      const refreshed = await endpoints.auth.me().catch(async () => {
        const { data } = await import('axios').then((axios) =>
          axios.default.post<{ accessToken: string; user: User }>(
            `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'}/auth/refresh`,
            {},
            { withCredentials: true },
          ),
        );
        setAccessToken(data.accessToken);
        return { data: data.user };
      });

      const user = refreshed.data as User;
      dispatch(setCredentials({ user, accessToken: '' }));
      return user;
    },
    retry: false,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (isError) {
      dispatch(signedOut());
      router.replace('/login');
    }
  }, [isError, dispatch, router]);

  if (isLoading || status === 'idle') {
    return (
      <div className="flex min-h-dvh">
        <div className="hidden w-60 shrink-0 border-r border-border p-4 lg:block">
          <Skeleton className="mb-6 h-7 w-32" />
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        </div>
        <div className="flex-1 p-6">
          <Skeleton className="mb-6 h-8 w-48" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-28 w-full rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />

        <main className="flex-1 px-4 py-5 sm:px-6 sm:py-6">{children}</main>

        {/* Not dismissible. A platform that outputs probabilities has to say
            what they are and aren't, on every page. */}
        <footer className="border-t border-border px-4 py-3 sm:px-6">
          <p className="text-[11px] leading-relaxed text-muted-foreground">{DISCLAIMER}</p>
        </footer>
      </div>
    </div>
  );
}
