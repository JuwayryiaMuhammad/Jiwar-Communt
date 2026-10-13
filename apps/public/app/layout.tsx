import type { Metadata, Viewport } from 'next';
import { LocaleProvider } from '@/components/locale';
import './globals.css';

// Every page is rendered per request: its scripts carry the nonce of that
// request's Content-Security-Policy (proxy.ts), and nothing is cached.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'جوار',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>
        <LocaleProvider>{children}</LocaleProvider>
      </body>
    </html>
  );
}
