'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Shield, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsListUnderline, TabsTriggerUnderline } from '@/components/ui/tabs';
import { EmptyState, StatCard } from '@/components/market/primitives';
import { endpoints } from '@/lib/api';
import { formatDate, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAppSelector } from '@/store/hooks';
import type { UserRole } from '@/types';

export default function AdminPage() {
  const role = useAppSelector((state) => state.auth.user?.role);

  // The API enforces this too — this is so a non-admin who navigates here gets
  // an explanation rather than a wall of failed requests.
  if (role && role !== 'ADMIN') {
    return (
      <EmptyState
        icon={Shield}
        title="Admin only"
        description="This area covers platform analytics, provider health and user management. Your account does not have access."
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Platform analytics, data provider health and user management.
        </p>
      </div>

      <Tabs defaultValue="analytics">
        <TabsListUnderline>
          <TabsTriggerUnderline value="analytics">Analytics</TabsTriggerUnderline>
          <TabsTriggerUnderline value="providers">Providers</TabsTriggerUnderline>
          <TabsTriggerUnderline value="users">Users</TabsTriggerUnderline>
        </TabsListUnderline>

        <TabsContent value="analytics">
          <Analytics />
        </TabsContent>
        <TabsContent value="providers">
          <Providers />
        </TabsContent>
        <TabsContent value="users">
          <Users />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ── Analytics ────────────────────────────────────────────────── */

interface AnalyticsData {
  users: { total: number; activeThisWeek: number; newThisWeek: number };
  content: { instruments: number; newsItemsToday: number; strategies: number };
  signals: { today: number; breakdownThisWeek: Array<{ action: string; count: number }> };
  alerts: { active: number };
  instrumentsByAssetClass: Array<{ assetClass: string; count: number }>;
}

function Analytics() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['admin-analytics'],
    queryFn: async () => (await endpoints.admin.analytics()).data as AnalyticsData,
    retry: false,
    refetchInterval: 60_000,
  });

  if (isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (isError) {
    return (
      <EmptyState
        icon={Shield}
        title="Analytics unavailable"
        description={(error as Error)?.message ?? 'Could not load platform analytics.'}
      />
    );
  }
  if (!data) return null;

  const totalSignals = data.signals.breakdownThisWeek.reduce((sum, row) => sum + row.count, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Users"
          value={String(data.users.total)}
          hint={`${data.users.activeThisWeek} active this week`}
        />
        <StatCard label="New this week" value={String(data.users.newThisWeek)} />
        <StatCard label="Signals today" value={String(data.signals.today)} />
        <StatCard label="Active alerts" value={String(data.alerts.active)} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <p className="text-[13px] font-medium">Signals this week</p>
            {totalSignals === 0 ? (
              <p className="mt-2 text-[12px] text-muted-foreground">None issued yet.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {data.signals.breakdownThisWeek.map((row) => (
                  <li key={row.action} className="flex items-center gap-3">
                    <Badge
                      variant={
                        row.action === 'BUY' ? 'bull' : row.action === 'SELL' ? 'bear' : 'secondary'
                      }
                    >
                      {row.action}
                    </Badge>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          'h-full rounded-full',
                          row.action === 'BUY'
                            ? 'bg-bull'
                            : row.action === 'SELL'
                              ? 'bg-bear'
                              : 'bg-muted-foreground/40',
                        )}
                        style={{ width: `${(row.count / totalSignals) * 100}%` }}
                      />
                    </div>
                    <span className="w-8 shrink-0 text-right tabular font-mono text-[12px]">
                      {row.count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <p className="text-[13px] font-medium">Instrument coverage</p>
            <ul className="mt-3 flex flex-col gap-2">
              {data.instrumentsByAssetClass.map((row) => (
                <li key={row.assetClass} className="flex items-center justify-between text-[12px]">
                  <span>{row.assetClass}</span>
                  <span className="tabular font-mono">{row.count}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 border-t border-border pt-2.5 text-[11px] text-muted-foreground">
              {data.content.instruments} active · {data.content.newsItemsToday} news items today ·{' '}
              {data.content.strategies} strategies
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ── Providers ────────────────────────────────────────────────── */

interface ProvidersData {
  marketData: Array<{
    provider: string;
    isHealthy: boolean;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    consecutiveFailures: number;
    lastError: string | null;
    averageLatencyMs: number;
    requestCount: number;
  }>;
  aiService: { reachable: boolean; detail: string; circuitOpen: boolean; url: string };
  cache: { available: boolean };
}

function Providers() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-providers'],
    queryFn: async () => (await endpoints.admin.providers()).data as ProvidersData,
    retry: false,
    refetchInterval: 30_000,
  });

  if (isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardContent className="flex items-start justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">Analysis engine</p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {data.aiService.url} · {data.aiService.detail}
              </p>
              {data.aiService.circuitOpen && (
                <Badge variant="bear" className="mt-1.5">
                  circuit open
                </Badge>
              )}
            </div>
            <HealthDot healthy={data.aiService.reachable} />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-start justify-between gap-3 p-4">
            <div>
              <p className="text-[13px] font-medium">Redis cache</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {data.cache.available
                  ? 'Connected — quotes and analysis are cached'
                  : 'Unavailable — every request hits upstream'}
              </p>
            </div>
            <HealthDot healthy={data.cache.available} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          {data.marketData.length === 0 ? (
            <p className="p-4 text-[12px] text-muted-foreground">
              No provider calls recorded yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">Provider</th>
                    <th className="px-3 py-2 text-left font-medium">State</th>
                    <th className="px-3 py-2 text-right font-medium">Avg latency</th>
                    <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Requests</th>
                    <th className="hidden px-3 py-2 text-left font-medium md:table-cell">Last event</th>
                  </tr>
                </thead>
                <tbody>
                  {data.marketData.map((provider) => (
                    <tr key={provider.provider} className="border-b border-border last:border-0">
                      <td className="px-3 py-2.5 font-medium">{provider.provider}</td>
                      <td className="px-3 py-2.5">
                        {provider.isHealthy ? (
                          <Badge variant="bull">healthy</Badge>
                        ) : (
                          <Badge variant="bear">
                            failing ({provider.consecutiveFailures})
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular font-mono">
                        {provider.averageLatencyMs}ms
                      </td>
                      <td className="hidden px-3 py-2.5 text-right tabular font-mono text-muted-foreground sm:table-cell">
                        {provider.requestCount.toLocaleString('en-IN')}
                      </td>
                      <td className="hidden px-3 py-2.5 text-[11px] text-muted-foreground md:table-cell">
                        {provider.isHealthy
                          ? provider.lastSuccessAt
                            ? `ok ${formatRelative(provider.lastSuccessAt)}`
                            : '—'
                          : (provider.lastError?.slice(0, 60) ?? 'unknown error')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Providers are a chain — each request walks it and takes the first success. A failing
        provider degrades quality but never breaks the page: the deterministic simulated provider
        terminates the chain and labels itself.
      </p>
    </div>
  );
}

function HealthDot({ healthy }: { healthy: boolean }) {
  const Icon = healthy ? CheckCircle2 : XCircle;
  return <Icon className={cn('size-5 shrink-0', healthy ? 'text-bull' : 'text-bear')} />;
}

/* ── Users ────────────────────────────────────────────────────── */

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  emailVerified: boolean;
  provider: string;
  createdAt: string;
  lastLoginAt: string | null;
  _count: { holdings: number; alerts: number; strategies: number };
}

function Users() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-users', query],
    queryFn: async () =>
      (await endpoints.admin.users({ q: query || undefined, limit: 50 })).data as {
        items: AdminUser[];
        total: number;
      },
    retry: false,
  });

  const update = useMutation({
    mutationFn: ({ id, role }: { id: string; role: UserRole }) =>
      endpoints.admin.updateUser(id, { role }),
    onSuccess: () => {
      toast.success('User updated');
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="flex flex-col gap-3">
      <Input
        placeholder="Search by name or email…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="max-w-sm"
      />

      {isLoading ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">User</th>
                    <th className="px-3 py-2 text-left font-medium">Role</th>
                    <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Activity</th>
                    <th className="hidden px-3 py-2 text-left font-medium md:table-cell">Last login</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.items ?? []).map((user) => (
                    <tr key={user.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2.5">
                        <p className="font-medium">{user.name}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {user.email}
                          {!user.emailVerified && ' · unverified'}
                          {!user.isActive && ' · disabled'}
                        </p>
                      </td>
                      <td className="px-3 py-2.5">
                        <Select
                          value={user.role}
                          onValueChange={(value) =>
                            update.mutate({ id: user.id, role: value as UserRole })
                          }
                        >
                          <SelectTrigger className="h-7 w-24">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="USER">USER</SelectItem>
                            <SelectItem value="PRO">PRO</SelectItem>
                            <SelectItem value="ADMIN">ADMIN</SelectItem>
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="hidden px-3 py-2.5 text-right text-[11px] text-muted-foreground sm:table-cell">
                        {user._count.holdings}h · {user._count.alerts}a · {user._count.strategies}s
                      </td>
                      <td className="hidden px-3 py-2.5 text-[11px] text-muted-foreground md:table-cell">
                        {user.lastLoginAt ? formatRelative(user.lastLoginAt) : 'never'}
                        <span className="block">joined {formatDate(user.createdAt)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {data && (
        <p className="text-[11px] text-muted-foreground">
          {data.items.length} of {data.total} users
        </p>
      )}
    </div>
  );
}
