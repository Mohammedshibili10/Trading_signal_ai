import type { Metadata, Viewport } from 'next';

import { APP_NAME, APP_TAGLINE } from '@/lib/constants';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: `${APP_NAME} — AI Trading Intelligence`, template: `%s · ${APP_NAME}` },
  description: APP_TAGLINE,
  applicationName: APP_NAME,
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfc' },
    { media: '(prefers-color-scheme: dark)', color: '#12141a' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning is required: next-themes sets the `class` and
    // `style` attributes on <html> before React hydrates, which is exactly the
    // mismatch this suppresses. Scoped to this element only.
    <html lang="en" suppressHydrationWarning>
      {/*
        Browser extensions inject attributes onto <body> before React loads —
        ColorZilla adds cz-shortcut-listen, wallet extensions add their own —
        and React then reports a mismatch for markup the app never produced.
        This suppresses attribute differences on the body element itself; it
        does not extend to children, so genuine mismatches inside the app are
        still reported.
      */}
      <body className="min-h-dvh antialiased" suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
