import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import '@jiwar/ui/styles.css';
import { Providers } from './providers';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Jiwar Manager', template: '%s · Jiwar Manager' },
  description: 'Compound management console',
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
