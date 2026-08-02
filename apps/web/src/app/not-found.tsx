import Link from 'next/link';

import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="text-xl font-semibold tracking-tight">This page doesn&apos;t exist</h1>
      <p className="max-w-sm text-[13px] text-muted-foreground">
        The link may be out of date, or the symbol may not be covered — this platform tracks Indian
        equities, forex, crypto and Indian investment products.
      </p>
      <Button asChild size="sm">
        <Link href="/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  );
}
