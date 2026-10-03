'use client';

import { AppShell, type NavGroup } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import {
  Building,
  DoorOpen,
  HardHat,
  Inbox,
  LayoutDashboard,
  ScrollText,
  Settings,
  ShieldCheck,
  UserCog,
  Users,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { bffAuth } from '@/lib/api';
import { fetchers, keys } from '@/lib/queries';

/** A queue's size for the sidebar: 0 on error (e.g. a role without access). */
function useQueueSize(key: readonly unknown[], fetch: () => Promise<{ data: unknown[] }>) {
  const q = useQuery({ queryKey: [...key, 'count'], queryFn: fetch, refetchInterval: 120_000, retry: false });
  return q.data?.data.length ?? 0;
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [signingOut, setSigningOut] = useState(false);
  const me = useQuery({ queryKey: keys.me, queryFn: fetchers.me, staleTime: 300_000 });
  const session = useQuery({
    queryKey: ['bff-session'],
    queryFn: () => bffAuth<{ tenantName: string | null }>('session', undefined, 'GET'),
    staleTime: Infinity,
  });

  const registrations = useQueueSize(keys.registrations, () => fetchers.registrations(undefined, 100));
  const household = useQueueSize(keys.household, () => fetchers.household(undefined, 100));
  const workers = useQueueSize(keys.engagements('pending_review'), () =>
    fetchers.engagements('pending_review', undefined, 100),
  );

  const nav: NavGroup[] = [
    { items: [{ href: '/', label: 'Overview', icon: <LayoutDashboard aria-hidden />, exact: true }] },
    {
      label: 'Community',
      items: [
        { href: '/requests', label: 'Requests', icon: <Inbox aria-hidden />, count: registrations + household },
        { href: '/units', label: 'Units', icon: <Building aria-hidden /> },
        { href: '/residents', label: 'Residents', icon: <Users aria-hidden /> },
        { href: '/workers', label: 'Workers', icon: <HardHat aria-hidden />, count: workers },
      ],
    },
    {
      label: 'Operations',
      items: [
        { href: '/gate', label: 'Gate', icon: <DoorOpen aria-hidden /> },
        { href: '/staff', label: 'Staff', icon: <UserCog aria-hidden /> },
      ],
    },
    {
      label: 'Administration',
      items: [
        { href: '/roles', label: 'Roles', icon: <ShieldCheck aria-hidden /> },
        { href: '/settings', label: 'Settings', icon: <Settings aria-hidden /> },
        { href: '/audit', label: 'Audit log', icon: <ScrollText aria-hidden /> },
      ],
    },
  ];

  async function signOut() {
    setSigningOut(true);
    await bffAuth('logout').catch(() => undefined);
    window.location.assign('/login');
  }

  return (
    <AppShell
      product="Jiwar Manager"
      context={session.data?.tenantName ?? 'Compound'}
      nav={nav}
      user={me.data ? { name: me.data.fullName ?? 'Manager', meta: me.data.email ?? me.data.phone ?? '' } : null}
      onSignOut={signOut}
      signingOut={signingOut}
    >
      {children}
    </AppShell>
  );
}
