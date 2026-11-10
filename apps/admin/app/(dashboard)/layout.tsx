'use client';

import { useT, type Translate } from '@jiwar/i18n';
import { AppShell, type NavGroup } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Building2, LayoutDashboard, ScrollText, ShieldCheck, UserCog } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { bffAuth } from '@/lib/api';
import appAr from '@/messages/ar/app';
import shellAr from '@/messages/ar/shell';
import appEn from '@/messages/en/app';
import shellEn from '@/messages/en/shell';

const nav = (t: Translate<typeof shellEn>): NavGroup[] => [
  {
    items: [{ href: '/', label: t('nav.overview'), icon: <LayoutDashboard aria-hidden />, exact: true }],
  },
  {
    label: t('group.platform'),
    items: [{ href: '/tenants', label: t('nav.tenants'), icon: <Building2 aria-hidden /> }],
  },
  {
    label: t('group.oversight'),
    items: [
      { href: '/security-events', label: t('nav.security-events'), icon: <ShieldCheck aria-hidden /> },
      { href: '/audit', label: t('nav.audit'), icon: <ScrollText aria-hidden /> },
    ],
  },
  {
    label: t('group.you'),
    items: [{ href: '/account', label: t('nav.account'), icon: <UserCog aria-hidden /> }],
  },
];

interface SessionInfo {
  email: string | null;
  signedIn: boolean;
  passwordChangeRequired: boolean;
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const t = useT(shellEn, shellAr);
  const app = useT(appEn, appAr);
  const groups = useMemo(() => nav(t), [t]);
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const session = useQuery({
    queryKey: ['bff-session'],
    queryFn: () => bffAuth<SessionInfo>('session', undefined, 'GET'),
    staleTime: Infinity,
  });

  useEffect(() => {
    if (session.data?.passwordChangeRequired && !session.data.signedIn) router.replace('/change-password');
  }, [session.data, router]);

  async function signOut() {
    setSigningOut(true);
    await bffAuth('logout').catch(() => undefined);
    window.location.assign('/login');
  }

  return (
    <AppShell
      product={app('meta.title')}
      context={t('context')}
      nav={groups}
      user={session.data?.email ? { name: session.data.email.split('@')[0] ?? '', meta: session.data.email } : null}
      onSignOut={signOut}
      signingOut={signingOut}
    >
      {children}
    </AppShell>
  );
}
