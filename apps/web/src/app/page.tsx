import { redirect } from 'next/navigation';

/**
 * The app has no marketing surface — the root simply routes into the product.
 * The `(app)` layout bounces unauthenticated visitors to /login after it tries
 * to exchange the refresh cookie, so returning users land straight in.
 */
export default function RootPage() {
  redirect('/dashboard');
}
