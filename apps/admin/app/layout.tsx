import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import '@jiwar/ui/styles.css';
import { Providers } from './providers';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Jiwar Platform', template: '%s · Jiwar Platform' },
  description: 'Platform console for Jiwar compounds',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
