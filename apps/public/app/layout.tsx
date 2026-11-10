import type { Metadata, Viewport } from 'next';
import { requestLocale } from '@jiwar/i18n/server';
import { LocaleProvider } from '@/components/locale';
import { ar } from '@/messages/ar';
import { en } from '@/messages/en';
import './globals.css';

// Every page is rendered per request: its scripts carry the nonce of that
// request's Content-Security-Policy (proxy.ts), and nothing is cached.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await requestLocale();
  return {
    title: (locale === 'ar' ? ar : en)['app.name'],
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

/** Arabic unless the language cookie says English: the first render is already in the right direction. */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, dir } = await requestLocale();
  return (
    <html lang={locale} dir={dir}>
      <body>
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
