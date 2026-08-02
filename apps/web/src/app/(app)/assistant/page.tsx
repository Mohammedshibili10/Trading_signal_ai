'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bot, Info, Send, User } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { SymbolSearch } from '@/components/market/symbol-search';
import { endpoints } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/types';

const SUGGESTIONS = [
  'What is the setup on RELIANCE right now?',
  'Why did the engine return WAIT on this symbol?',
  'What does a 62% probability actually mean here?',
  'Explain the difference between an order block and support.',
  'How should I size a trade with a 3% stop?',
];

interface SessionRow {
  id: string;
  title: string;
  symbol: string | null;
  updatedAt: string;
}

export default function AssistantPage() {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [symbol, setSymbol] = useState<string>('');
  const [draft, setDraft] = useState('');
  /** Optimistic thread so the question appears instantly. */
  const [pending, setPending] = useState<ChatMessage[]>([]);

  const bottomRef = useRef<HTMLDivElement>(null);

  const status = useQuery({
    queryKey: ['assistant-status'],
    queryFn: async () => (await endpoints.assistant.status()).data as { llm: boolean; model: string },
    staleTime: 5 * 60_000,
    retry: false,
  });

  const sessions = useQuery({
    queryKey: ['assistant-sessions'],
    queryFn: async () => (await endpoints.assistant.sessions()).data as SessionRow[],
    staleTime: 60_000,
  });

  const messages = useQuery({
    queryKey: ['assistant-messages', sessionId],
    queryFn: async () => (await endpoints.assistant.messages(sessionId!)).data as ChatMessage[],
    enabled: Boolean(sessionId),
  });

  const ask = useMutation({
    mutationFn: (question: string) =>
      endpoints.assistant.ask(question, symbol || undefined, sessionId),
    onSuccess: (response) => {
      const data = response.data as { sessionId: string };
      setSessionId(data.sessionId);
      setPending([]);
      queryClient.invalidateQueries({ queryKey: ['assistant-messages', data.sessionId] });
      queryClient.invalidateQueries({ queryKey: ['assistant-sessions'] });
    },
    onError: (error: Error) => {
      setPending((current) => current.slice(0, -1));
      toast.error(error.message);
    },
  });

  const thread = [...(messages.data ?? []), ...pending];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread.length, ask.isPending]);

  function submit(question: string) {
    const trimmed = question.trim();
    if (!trimmed || ask.isPending) return;

    setPending([
      {
        id: `pending-${trimmed.length}-${thread.length}`,
        role: 'user',
        content: trimmed,
        createdAt: new Date().toISOString(),
        pending: true,
      },
    ]);
    setDraft('');
    ask.mutate(trimmed);
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-6xl gap-4">
      {/* History */}
      <aside className="hidden w-56 shrink-0 flex-col gap-2 lg:flex">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setSessionId(undefined);
            setPending([]);
          }}
        >
          New conversation
        </Button>

        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-1 pr-2">
            {(sessions.data ?? []).map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => {
                  setSessionId(session.id);
                  setPending([]);
                  if (session.symbol) setSymbol(session.symbol);
                }}
                className={cn(
                  'rounded-lg px-2.5 py-2 text-left transition-colors',
                  session.id === sessionId ? 'bg-muted' : 'hover:bg-muted/60',
                )}
              >
                <p className="truncate text-[12px] font-medium">{session.title}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {session.symbol ? `${session.symbol} · ` : ''}
                  {formatRelative(session.updatedAt)}
                </p>
              </button>
            ))}
          </div>
        </ScrollArea>
      </aside>

      {/* Thread */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Assistant</h1>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Answers are grounded in the analysis engine, not generated from scratch.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {symbol ? (
              <Badge variant="outline" className="gap-1.5">
                {symbol}
                <button
                  type="button"
                  onClick={() => setSymbol('')}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Clear symbol context"
                >
                  ×
                </button>
              </Badge>
            ) : (
              <SymbolSearch onSelect={setSymbol} className="w-40" />
            )}
          </div>
        </div>

        {status.data && !status.data.llm && (
          <Card className="border-border">
            <CardContent className="flex items-start gap-2.5 p-3">
              <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                No language model key is configured, so answers come back as structured templates
                rather than prose. The facts are identical — <code>GEMINI_API_KEY</code> only
                changes how they are phrased.
              </p>
            </CardContent>
          </Card>
        )}

        <Card className="flex min-h-0 flex-1 flex-col">
          <CardContent className="flex min-h-0 flex-1 flex-col p-0">
            <ScrollArea className="flex-1">
              <div className="flex flex-col gap-4 p-4">
                {!sessionId && thread.length === 0 ? (
                  <div className="flex flex-col items-center gap-4 py-10 text-center">
                    <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                      <Bot className="size-5 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-[14px] font-medium">Ask about any setup</p>
                      <p className="mx-auto mt-1 max-w-md text-[13px] text-muted-foreground">
                        Pick a symbol for context and the assistant reads the same analysis the
                        chart does. It is not allowed to introduce numbers the engine did not
                        produce.
                      </p>
                    </div>
                    <div className="flex flex-wrap justify-center gap-2">
                      {SUGGESTIONS.map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          onClick={() => submit(suggestion)}
                          className="rounded-full border border-border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : messages.isLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-16 w-2/3 rounded-lg" />
                    <Skeleton className="ml-auto h-24 w-3/4 rounded-lg" />
                  </div>
                ) : (
                  thread.map((message) => <Message key={message.id} message={message} />)
                )}

                {ask.isPending && (
                  <div className="flex gap-3">
                    <Avatar role="assistant" />
                    <div className="flex items-center gap-1.5 pt-1.5">
                      {[0, 150, 300].map((delay) => (
                        <span
                          key={delay}
                          className="size-1.5 animate-pulse rounded-full bg-muted-foreground/50"
                          style={{ animationDelay: `${delay}ms` }}
                        />
                      ))}
                    </div>
                  </div>
                )}

                <div ref={bottomRef} />
              </div>
            </ScrollArea>

            <form
              className="flex items-center gap-2 border-t border-border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                submit(draft);
              }}
            >
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={symbol ? `Ask about ${symbol}…` : 'Ask a question…'}
                disabled={ask.isPending}
              />
              <Button type="submit" size="icon" disabled={!draft.trim() || ask.isPending}>
                <Send className="size-4" />
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-[11px] text-muted-foreground">
          Not investment advice. The assistant explains the engine&apos;s reasoning; it does not
          make calls of its own.
        </p>
      </div>
    </div>
  );
}

function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={cn('flex gap-3', isUser && 'flex-row-reverse')}>
      <Avatar role={message.role} />
      <div className={cn('min-w-0 max-w-[80%]', isUser && 'text-right')}>
        <div
          className={cn(
            'inline-block whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-left text-[13px] leading-relaxed',
            isUser ? 'bg-primary/10 text-foreground' : 'bg-muted',
            message.pending && 'opacity-60',
          )}
        >
          {message.content}
        </div>
        {message.context?.symbols && message.context.symbols.length > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Context: {message.context.symbols.join(', ')}
          </p>
        )}
      </div>
    </div>
  );
}

function Avatar({ role }: { role: 'user' | 'assistant' }) {
  const Icon = role === 'user' ? User : Bot;
  return (
    <div
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-full',
        role === 'user' ? 'bg-primary/12 text-primary' : 'bg-muted text-muted-foreground',
      )}
    >
      <Icon className="size-3.5" />
    </div>
  );
}
