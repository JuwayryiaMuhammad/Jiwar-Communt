import type { Metadata } from 'next';
import { IBM_Plex_Sans_Arabic, Inter } from 'next/font/google';
import { translator } from '@jiwar/i18n/core';
import { requestLocale } from '@jiwar/i18n/server';
import '@jiwar/ui/styles.css';
import ar from '@/messages/ar/app';
import en from '@/messages/en/app';
import { Providers } from './providers';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
// Inter has no Arabic letters: they fall through to this face.
const arabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-arabic',
  display: 'swap',
});

export async function generateMetadata(): Promise<Metadata> {
  const t = translator((await requestLocale()).locale, en, ar);
  return {
    title: { default: t('meta.title'), template: t('meta.template') },
    description: t('meta.description'),
    robots: { index: false, follow: false },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, dir } = await requestLocale();
  return (
    <html lang={locale} dir={dir} className={`${inter.variable} ${arabic.variable}`}>
      <body>
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
