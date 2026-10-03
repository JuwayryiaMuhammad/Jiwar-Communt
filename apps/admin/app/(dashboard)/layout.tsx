'use client';

import { AppShell, type NavGroup } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Building2, LayoutDashboard, ScrollText, ShieldCheck, UserCog } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { bffAuth } from '@/lib/api';

const NAV: NavGroup[] = [
  {
    items: [{ href: '/', label: 'Overview', icon: <LayoutDashboard aria-hidden />, exact: true }],
  },
  {
    label: 'Platform',
    items: [{ href: '/tenants', label: 'Compounds', icon: <Building2 aria-hidden /> }],
  },
  {
    label: 'Oversight',
    items: [
      { href: '/security-events', label: 'Security events', icon: <ShieldCheck aria-hidden /> },
      { href: '/audit', label: 'Audit log', icon: <ScrollText aria-hidden /> },
    ],
  },
  {
    label: 'You',
    items: [{ href: '/account', label: 'Account', icon: <UserCog aria-hidden /> }],
  },
];

interface SessionInfo {
  email: string | null;
  signedIn: boolean;
  passwordChangeRequired: boolean;
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
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
      product="Jiwar Platform"
      context="Super admin"
      nav={NAV}
      user={session.data?.email ? { name: session.data.email.split('@')[0] ?? '', meta: session.data.email } : null}
      onSignOut={signOut}
      signingOut={signingOut}
    >
      {children}
    </AppShell>
  );
}
