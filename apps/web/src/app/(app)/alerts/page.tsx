'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bell, BellOff, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/market/primitives';
import { SymbolSearch } from '@/components/market/symbol-search';
import { endpoints } from '@/lib/api';
import { formatDate, formatRelative } from '@/lib/format';
import { useLiveNotifications } from '@/lib/realtime';
import type { AlertType } from '@/types';

interface AlertRow {
  id: string;
  symbol: string;
  type: AlertType;
  threshold: string | number | null;
  channels: string[];
  isActive: boolean;
  triggeredAt: string | null;
  note: string | null;
  createdAt: string;
  instrument?: { name: string; assetClass: string };
}

/** Types that need a number, and what that number means for each. */
const ALERT_TYPES: Array<{ value: AlertType; label: string; unit: string | null; hint: string }> = [
  { value: 'PRICE_ABOVE', label: 'Price rises above', unit: '₹', hint: 'Fires once price crosses upward' },
  { value: 'PRICE_BELOW', label: 'Price falls below', unit: '₹', hint: 'Fires once price crosses downward' },
  { value: 'PERCENT_CHANGE', label: 'Moves by', unit: '%', hint: 'Absolute move from the previous close' },
  { value: 'VOLUME_SPIKE', label: 'Volume spike', unit: null, hint: 'Volume well above its 20-day average' },
  { value: 'RSI_ABOVE', label: 'RSI rises above', unit: '', hint: 'Typically 70 for overbought' },
  { value: 'RSI_BELOW', label: 'RSI falls below', unit: '', hint: 'Typically 30 for oversold' },
  { value: 'AI_SIGNAL', label: 'New AI signal', unit: null, hint: 'Any signal the engine issues on this instrument' },
  { value: 'PATTERN', label: 'Pattern detected', unit: null, hint: 'A chart pattern completes or confirms' },
  { value: 'STOP_LOSS', label: 'Stop loss hit', unit: '₹', hint: 'Price reaches your stop level' },
];

const TYPE_LABEL = Object.fromEntries(ALERT_TYPES.map((t) => [t.value, t.label])) as Record<
  AlertType,
  string
>;

export default function AlertsPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  // Alert triggers arrive on the per-user socket channel, so a firing alert
  // updates the list without waiting for the next poll.
  const { notifications } = useLiveNotifications();

  const { data, isLoading } = useQuery({
    queryKey: ['alerts', notifications.length],
    queryFn: async () => (await endpoints.alerts.list()).data as AlertRow[],
    refetchInterval: 60_000,
  });

  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      endpoints.alerts.toggle(id, isActive),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alerts'] }),
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => endpoints.alerts.remove(id),
    onSuccess: () => {
      toast.success('Alert deleted');
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const alerts = data ?? [];
  const active = alerts.filter((alert) => alert.isActive);
  const triggered = alerts.filter((alert) => alert.triggeredAt);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Alerts</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {active.length} active · {triggered.length} triggered. Checked server-side, so they fire
            whether or not this tab is open.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus /> New alert
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : alerts.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="No alerts set"
          description="Alerts watch price, volume, RSI, patterns and AI signals. They are evaluated on the server every minute."
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus /> New alert
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {alerts.map((alert) => (
                <div key={alert.id} className="group flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/markets/${alert.symbol}`}
                        className="text-[13px] font-medium hover:underline"
                      >
                        {alert.symbol}
                      </Link>
                      {alert.triggeredAt ? (
                        <Badge variant="bull">
                          triggered {formatRelative(alert.triggeredAt)}
                        </Badge>
                      ) : alert.isActive ? (
                        <Badge variant="secondary">watching</Badge>
                      ) : (
                        <Badge variant="neutral">paused</Badge>
                      )}
                    </div>

                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                      {TYPE_LABEL[alert.type] ?? alert.type}
                      {alert.threshold !== null && alert.threshold !== undefined
                        ? ` ${Number(alert.threshold).toLocaleString('en-IN')}`
                        : ''}
                      {alert.note ? ` · ${alert.note}` : ''}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Created {formatDate(alert.createdAt)} · {alert.channels.join(', ').toLowerCase()}
                    </p>
                  </div>

                  <Switch
                    checked={alert.isActive}
                    onCheckedChange={(checked) => toggle.mutate({ id: alert.id, isActive: checked })}
                    aria-label={alert.isActive ? 'Pause alert' : 'Enable alert'}
                  />

                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={() => remove.mutate(alert.id)}
                    aria-label={`Delete alert on ${alert.symbol}`}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {alerts.length > 0 && active.length === 0 && (
        <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <BellOff className="size-3.5" />
          Every alert is paused — nothing will fire.
        </p>
      )}

      <CreateAlertDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function CreateAlertDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [symbol, setSymbol] = useState('');
  const [type, setType] = useState<AlertType>('PRICE_ABOVE');
  const [threshold, setThreshold] = useState('');
  const [note, setNote] = useState('');

  const definition = ALERT_TYPES.find((item) => item.value === type)!;
  const needsThreshold = definition.unit !== null;

  const create = useMutation({
    mutationFn: () =>
      endpoints.alerts.create({
        symbol,
        type,
        ...(needsThreshold ? { threshold: Number(threshold) } : {}),
        ...(note ? { note } : {}),
        channels: ['IN_APP'],
      }),
    onSuccess: () => {
      toast.success('Alert created');
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
      onOpenChange(false);
      setSymbol('');
      setThreshold('');
      setNote('');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const valid = Boolean(symbol) && (!needsThreshold || Number(threshold) > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New alert</DialogTitle>
          <DialogDescription>
            Evaluated server-side every minute against the live feed.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Instrument</Label>
            {symbol ? (
              <div className="flex items-center gap-2">
                <Badge variant="outline">{symbol}</Badge>
                <button
                  type="button"
                  onClick={() => setSymbol('')}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  change
                </button>
              </div>
            ) : (
              <SymbolSearch onSelect={setSymbol} className="w-full" />
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Condition</Label>
            <Select value={type} onValueChange={(value) => setType(value as AlertType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALERT_TYPES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{definition.hint}</p>
          </div>

          {needsThreshold && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="threshold">Value {definition.unit ? `(${definition.unit})` : ''}</Label>
              <Input
                id="threshold"
                type="number"
                step="any"
                min="0"
                value={threshold}
                onChange={(event) => setThreshold(event.target.value)}
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="note">Note (optional)</Label>
            <Input
              id="note"
              placeholder="Why you're watching this level"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>
            Create alert
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
