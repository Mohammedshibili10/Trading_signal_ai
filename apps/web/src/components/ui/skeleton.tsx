import { cn } from '@/lib/utils';

/** Loading placeholder. Uses a slow opacity pulse rather than a sweep. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-[shimmer_1.6s_ease-in-out_infinite] rounded-md bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };
