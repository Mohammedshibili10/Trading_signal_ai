import { redirect } from 'next/navigation';

/**
 * Superseded by the Backtesting & Analytics section.
 *
 * Kept as a redirect rather than deleted so existing links and bookmarks land
 * on the equivalent page instead of a 404.
 */
export default function PerformanceRedirect() {
  redirect('/analytics');
}
