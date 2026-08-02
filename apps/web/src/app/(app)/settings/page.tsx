'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { Check, Eye, LogOut, Monitor, Moon, Save, Send, Sun, Unlink } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsListUnderline, TabsTriggerUnderline } from '@/components/ui/tabs';
import { endpoints } from '@/lib/api';
import { ASSET_CLASSES } from '@/lib/constants';
import { formatCompactINR, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { setRiskSettings } from '@/store/slices/risk-slice';
import { togglePrivacyMode } from '@/store/slices/ui-slice';
import type { User, UserPreferences } from '@/types';

export default function SettingsPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Profile, appearance, risk defaults and notifications.
        </p>
      </div>

      <Tabs defaultValue="profile">
        <TabsListUnderline>
          <TabsTriggerUnderline value="profile">Profile</TabsTriggerUnderline>
          <TabsTriggerUnderline value="trading">Trading</TabsTriggerUnderline>
          <TabsTriggerUnderline value="notifications">Notifications</TabsTriggerUnderline>
          <TabsTriggerUnderline value="security">Security</TabsTriggerUnderline>
        </TabsListUnderline>

        <TabsContent value="profile">
          <ProfileSettings />
        </TabsContent>
        <TabsContent value="trading">
          <TradingSettings />
        </TabsContent>
        <TabsContent value="notifications">
          <NotificationSettings />
        </TabsContent>
        <TabsContent value="security">
          <SecuritySettings />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function useProfile() {
  return useQuery({
    queryKey: ['profile'],
    queryFn: async () => (await endpoints.users.me()).data as User,
  });
}

/* ── Profile ──────────────────────────────────────────────────── */

function ProfileSettings() {
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();
  const privacyMode = useAppSelector((state) => state.ui.privacyMode);
  const { theme, setTheme } = useTheme();
  const { data, isLoading } = useProfile();

  const [name, setName] = useState('');
  useEffect(() => {
    if (data?.name) setName(data.name);
  }, [data?.name]);

  const save = useMutation({
    mutationFn: () => endpoints.users.updateProfile({ name }),
    onSuccess: () => {
      toast.success('Profile updated');
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Email</Label>
            <div className="flex items-center gap-2">
              <Input value={data?.email ?? ''} disabled />
              {data?.emailVerified ? (
                <Badge variant="bull">verified</Badge>
              ) : (
                <Badge variant="neutral">unverified</Badge>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
            <Badge variant="secondary">{data?.role}</Badge>
            <span>·</span>
            <span>signed in with {data?.provider === 'GOOGLE' ? 'Google' : 'email'}</span>
            {data?.createdAt && (
              <>
                <span>·</span>
                <span>member since {formatDate(data.createdAt)}</span>
              </>
            )}
          </div>

          <Button
            size="sm"
            className="w-fit"
            loading={save.isPending}
            disabled={!name.trim() || name === data?.name}
            onClick={() => save.mutate()}
          >
            <Save /> Save
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <div>
            <p className="text-[13px] font-medium">Appearance</p>
            <div className="mt-2 flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5 w-fit">
              {(
                [
                  { key: 'light', label: 'Light', icon: Sun },
                  { key: 'dark', label: 'Dark', icon: Moon },
                  { key: 'system', label: 'System', icon: Monitor },
                ] as const
              ).map((option) => {
                const Icon = option.icon;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setTheme(option.key)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors',
                      theme === option.key
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Icon className="size-3.5" />
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <Separator />

          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="flex items-center gap-1.5 text-[13px] font-medium">
                <Eye className="size-3.5" /> Privacy mode
              </p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                Masks every rupee amount. For screen sharing without showing your book.
              </p>
            </div>
            <Switch
              checked={privacyMode}
              onCheckedChange={() => dispatch(togglePrivacyMode())}
              aria-label="Privacy mode"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Trading ──────────────────────────────────────────────────── */

function TradingSettings() {
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();
  const { data, isLoading } = useProfile();

  const [preferences, setPreferences] = useState<Partial<UserPreferences>>({});

  useEffect(() => {
    if (data?.preferences) setPreferences(data.preferences);
  }, [data?.preferences]);

  const save = useMutation({
    mutationFn: () =>
      endpoints.users.updatePreferences({
        defaultAssetClass: preferences.defaultAssetClass,
        baseCurrency: preferences.baseCurrency,
        capital: preferences.capital,
        riskPerTradePercent: preferences.riskPerTradePercent,
        dailyLossLimitPercent: preferences.dailyLossLimitPercent,
        weeklyLossLimitPercent: preferences.weeklyLossLimitPercent,
        maxDrawdownPercent: preferences.maxDrawdownPercent,
      }),
    onSuccess: () => {
      toast.success('Preferences saved');
      // Mirror into Redux so the calculators pick the change up immediately
      // rather than on the next full page load.
      dispatch(
        setRiskSettings({
          capital: preferences.capital,
          riskPerTradePercent: preferences.riskPerTradePercent,
          dailyLossLimitPercent: preferences.dailyLossLimitPercent,
          weeklyLossLimitPercent: preferences.weeklyLossLimitPercent,
          maxDrawdownPercent: preferences.maxDrawdownPercent,
        }),
      );
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (isLoading) return <Skeleton className="h-96 w-full rounded-xl" />;

  const set = <K extends keyof UserPreferences>(key: K, value: UserPreferences[K]) =>
    setPreferences((current) => ({ ...current, [key]: value }));

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label>Default category</Label>
            <Select
              value={preferences.defaultAssetClass ?? 'EQUITY'}
              onValueChange={(value) => set('defaultAssetClass', value as UserPreferences['defaultAssetClass'])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSET_CLASSES.map((item) => (
                  <SelectItem key={item.key} value={item.key}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Base currency</Label>
            <Select
              value={preferences.baseCurrency ?? 'INR'}
              onValueChange={(value) => set('baseCurrency', value as 'INR' | 'USD')}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="INR">₹ Indian Rupee</SelectItem>
                <SelectItem value="USD">$ US Dollar</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="capital">Trading capital</Label>
            <span className="tabular font-mono text-[12px] text-muted-foreground">
              {formatCompactINR(preferences.capital ?? 0)}
            </span>
          </div>
          <Input
            id="capital"
            type="number"
            min="0"
            step="10000"
            value={preferences.capital ?? 0}
            onChange={(event) => set('capital', Number(event.target.value))}
          />
        </div>

        <Separator />

        <p className="text-[13px] font-medium">Risk limits</p>

        <RiskSlider
          label="Risk per trade"
          value={preferences.riskPerTradePercent ?? 1}
          min={0.1}
          max={5}
          step={0.1}
          onChange={(value) => set('riskPerTradePercent', value)}
          note="Capped at 5%. Above 2%, an ordinary losing streak becomes an account-level event."
        />
        <RiskSlider
          label="Daily loss limit"
          value={preferences.dailyLossLimitPercent ?? 3}
          min={0.5}
          max={20}
          step={0.5}
          onChange={(value) => set('dailyLossLimitPercent', value)}
        />
        <RiskSlider
          label="Weekly loss limit"
          value={preferences.weeklyLossLimitPercent ?? 6}
          min={1}
          max={40}
          step={1}
          onChange={(value) => set('weeklyLossLimitPercent', value)}
        />
        <RiskSlider
          label="Max drawdown"
          value={preferences.maxDrawdownPercent ?? 15}
          min={2}
          max={60}
          step={1}
          onChange={(value) => set('maxDrawdownPercent', value)}
          note="Reaching this halts new signals until you review the system."
        />

        <Button size="sm" className="w-fit" loading={save.isPending} onClick={() => save.mutate()}>
          <Save /> Save preferences
        </Button>
      </CardContent>
    </Card>
  );
}

function RiskSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  note,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  note?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <Label>{label}</Label>
        <span className="tabular font-mono text-[13px] font-medium">{value.toFixed(1)}%</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([next]) => onChange(next)} />
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

/* ── Notifications ────────────────────────────────────────────── */

function NotificationSettings() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useProfile();
  const [notifications, setNotifications] = useState<UserPreferences['notifications']>({
    email: true,
    push: false,
    priceAlerts: true,
    signalAlerts: true,
    newsAlerts: false,
  });

  useEffect(() => {
    if (data?.preferences?.notifications) setNotifications(data.preferences.notifications);
  }, [data?.preferences?.notifications]);

  const save = useMutation({
    mutationFn: (next: UserPreferences['notifications']) =>
      endpoints.users.updatePreferences({ notifications: next }),
    onSuccess: () => {
      toast.success('Notification preferences saved');
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;

  const rows: Array<{ key: keyof UserPreferences['notifications']; label: string; hint: string }> = [
    { key: 'priceAlerts', label: 'Price alerts', hint: 'When an alert you set triggers' },
    { key: 'signalAlerts', label: 'AI signals', hint: 'New signals on instruments you follow' },
    { key: 'newsAlerts', label: 'News', hint: 'High-impact news on your watchlist' },
    { key: 'email', label: 'Email', hint: 'Send the above by email as well as in-app' },
    { key: 'push', label: 'Push', hint: 'Browser push notifications' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <TelegramCard />

    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        {rows.map((row, index) => (
          <div key={row.key}>
            {index > 0 && <Separator className="my-3" />}
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[13px] font-medium">{row.label}</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">{row.hint}</p>
              </div>
              <Switch
                checked={notifications[row.key]}
                onCheckedChange={(checked) => {
                  const next = { ...notifications, [row.key]: checked };
                  setNotifications(next);
                  save.mutate(next);
                }}
                aria-label={row.label}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
    </div>
  );
}

interface TelegramStatus {
  configured: boolean;
  linked: boolean;
  botUsername: string | null;
  chatId: string | null;
  note: string;
}

/**
 * Telegram delivery.
 *
 * The chat id is discovered rather than typed. Telegram does not surface it
 * anywhere in its own UI, so asking a user to paste one means sending them to
 * a third-party bot to find out — which is both a poor experience and a strange
 * thing to ask someone to do with their account.
 */
function TelegramCard() {
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: ['telegram'],
    queryFn: async () => (await endpoints.telegram.status()).data as TelegramStatus,
    retry: false,
  });

  const link = useMutation({
    mutationFn: () => endpoints.telegram.link(),
    onSuccess: (response) => {
      toast.success((response.data as { message: string }).message);
      queryClient.invalidateQueries({ queryKey: ['telegram'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const test = useMutation({
    mutationFn: () => endpoints.telegram.test(),
    onSuccess: () => toast.success('Test message sent — check Telegram.'),
    onError: (error: Error) => toast.error(error.message),
  });

  const unlink = useMutation({
    mutationFn: () => endpoints.telegram.unlink(),
    onSuccess: () => {
      toast.success('Telegram disconnected');
      queryClient.invalidateQueries({ queryKey: ['telegram'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (status.isLoading) return <Skeleton className="h-40 w-full rounded-xl" />;

  const data = status.data;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-[13px] font-medium">
              Telegram
              {data?.linked && (
                <Badge variant="bull">
                  <Check className="size-3" /> connected
                </Badge>
              )}
            </p>
            <p className="mt-0.5 max-w-md text-[12px] text-muted-foreground">
              Every signal delivered to your phone with entry, stop, all three targets,
              reward:risk and the reasoning behind it.
            </p>
          </div>

          {data?.linked ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" loading={test.isPending} onClick={() => test.mutate()}>
                <Send /> Send test
              </Button>
              <Button size="sm" variant="ghost" loading={unlink.isPending} onClick={() => unlink.mutate()}>
                <Unlink /> Disconnect
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              disabled={!data?.configured}
              loading={link.isPending}
              onClick={() => link.mutate()}
            >
              Connect
            </Button>
          )}
        </div>

        {!data?.linked && (
          <ol className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3 text-[12px] text-muted-foreground">
            {data?.configured && data.botUsername ? (
              <>
                <li>
                  1. Open Telegram and message{' '}
                  <a
                    href={`https://t.me/${data.botUsername}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-primary hover:underline"
                  >
                    @{data.botUsername}
                  </a>{' '}
                  — send <code className="rounded bg-muted px-1">/start</code>.
                </li>
                <li>2. Come back here and press Connect.</li>
              </>
            ) : (
              <li>{data?.note}</li>
            )}
          </ol>
        )}

        {data?.linked && (
          <p className="mt-3 border-t border-border pt-3 text-[11px] text-muted-foreground">
            Chat {data.chatId}
            {data.botUsername ? ` · via @${data.botUsername}` : ''}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* ── Security ─────────────────────────────────────────────────── */

interface SessionRow {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  current?: boolean;
}

function SecuritySettings() {
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: async () => (await endpoints.auth.sessions()).data as SessionRow[],
    retry: false,
  });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="p-4">
          <p className="text-[13px] font-medium">Active sessions</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Refresh tokens rotate on every use. A replayed token revokes every session on this
            account — so if you see something you don&apos;t recognise, change your password and
            everything here is invalidated.
          </p>

          <div className="mt-3 flex flex-col gap-2">
            {sessions.isLoading ? (
              <Skeleton className="h-16 w-full rounded-lg" />
            ) : (sessions.data ?? []).length === 0 ? (
              <p className="text-[12px] text-muted-foreground">No other sessions.</p>
            ) : (
              sessions.data!.map((session) => (
                <div
                  key={session.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[12px] font-medium">
                      {session.userAgent?.slice(0, 60) ?? 'Unknown device'}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {session.ipAddress ?? 'unknown IP'} · started {formatDate(session.createdAt, true)}
                    </p>
                  </div>
                  {session.current && <Badge variant="bull">this device</Badge>}
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-start justify-between gap-4 p-4">
          <div>
            <p className="text-[13px] font-medium">Sign out everywhere</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Ends every session including this one.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await endpoints.auth.logout();
              window.location.href = '/login';
            }}
          >
            <LogOut /> Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
