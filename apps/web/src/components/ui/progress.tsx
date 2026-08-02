'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number;
  max?: number;
  /** Bar colour. Defaults to the brand accent. */
  indicatorClassName?: string;
  size?: 'sm' | 'default';
}

/**
 * Deterministic progress/meter bar. Used for confidence, scores and allocation
 * shares — anywhere a 0…100 value needs a visual weight.
 */
const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value, max = 100, indicatorClassName, size = 'default', ...props }, ref) => {
    const pct = Math.min(100, Math.max(0, (value / max) * 100));
    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={max}
        className={cn(
          'w-full overflow-hidden rounded-full bg-muted',
          size === 'sm' ? 'h-1' : 'h-1.5',
          className,
        )}
        {...props}
      >
        <div
          className={cn('h-full rounded-full bg-primary transition-[width] duration-300', indicatorClassName)}
          style={{ width: `${pct}%` }}
        />
      </div>
    );
  },
);
Progress.displayName = 'Progress';

/**
 * Bidirectional meter for values that run negative→positive (e.g. a −100…+100
 * technical score). Zero sits at the centre.
 */
function BipolarMeter({
  value,
  className,
  min = -100,
  max = 100,
}: {
  value: number;
  className?: string;
  min?: number;
  max?: number;
}) {
  const clamped = Math.min(max, Math.max(min, value));
  const half = (max - min) / 2;
  const magnitude = (Math.abs(clamped) / half) * 50;
  const positive = clamped >= 0;

  return (
    <div className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-border" />
      <div
        className={cn('absolute top-0 h-full rounded-full', positive ? 'bg-bull' : 'bg-bear')}
        style={{
          width: `${magnitude}%`,
          left: positive ? '50%' : undefined,
          right: positive ? undefined : '50%',
        }}
      />
    </div>
  );
}

export { Progress, BipolarMeter };
