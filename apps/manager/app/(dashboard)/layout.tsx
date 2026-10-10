'use client';

import { ErrorAlert } from '@jiwar/api/react';
import { AppShell, Button, EmptyState, SkeletonRows, type NavGroup, type NavItem } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import {
  Building,
  DoorOpen,
  HardHat,
  Inbox,
  LayoutDashboard,
  Lock,
  ScrollText,
  Settings,
  ShieldCheck,
  UserCog,
  Users,
  Wrench,
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { mayEnter } from '@/lib/access';
import { bffAuth } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

/** A queue's size for the sidebar; not asked for by a role without access. */
function useQueueSize(key: readonly unknown[], fetch: () => Promise<{ data: unknown[] }>, enabled: boolean) {
  const q = useQuery({ queryKey: [...key, 'count'], queryFn: fetch, refetchInterval: 120_000, retry: false, enabled });
  return q.data?.data.length ?? 0;
}

type GatedItem = NavItem & { show: boolean };

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [signingOut, setSigningOut] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const { me, ready, can, error: meError } = usePermissions();
  const session = useQuery({
    queryKey: ['bff-session'],
    queryFn: () => bffAuth<{ tenantName: string | null }>('session', undefined, 'GET'),
    staleTime: Infinity,
  });

  const isManager = me?.type === 'manager';
  const registrations = useQueueSize(
    keys.registrations,
    () => fetchers.registrations(undefined, 100),
    can('residents.manage'),
  );
  const household = useQueueSize(keys.household, () => fetchers.household(undefined, 100), can('household.approve'));
  const workers = useQueueSize(
    keys.engagements('pending_review'),
    () => fetchers.engagements('pending_review', undefined, 100),
    can('workers.review'),
  );
  // The dispatch queue: new tickets, which nobody has yet.
  const unassigned = useQueueSize(
    keys.tickets({ status: 'new' }),
    () => fetchers.tickets({ status: 'new' }, undefined, 100),
    can('tickets.dispatch'),
  );

  // Each entry shows only to a role that may read what its page opens with.
  const groups: { label?: string; items: GatedItem[] }[] = [
    {
      // The overview mixes every area's queues: the manager's own page.
      items: [{ href: '/', label: 'Overview', icon: <LayoutDashboard aria-hidden />, exact: true, show: isManager }],
    },
    {
      label: 'Community',
      items: [
        {
          href: '/requests',
          label: 'Requests',
          icon: <Inbox aria-hidden />,
          count: registrations + household,
          show: can('residents.manage') || can('household.approve'),
        },
        { href: '/units', label: 'Units', icon: <Building aria-hidden />, show: isManager && can('units.read') },
        { href: '/residents', label: 'Residents', icon: <Users aria-hidden />, show: can('residents.read') },
        {
          href: '/workers',
          label: 'Workers',
          icon: <HardHat aria-hidden />,
          count: workers,
          show: can('workers.review') || can('workers.compliance') || can('workers.incidents'),
        },
      ],
    },
    {
      label: 'Operations',
      items: [
        {
          href: '/maintenance',
          label: 'Maintenance',
          icon: <Wrench aria-hidden />,
          count: unassigned,
          show: can('tickets.dispatch'),
        },
        { href: '/gate', label: 'Gate', icon: <DoorOpen aria-hidden />, show: can('gate.read') },
        { href: '/staff', label: 'Staff', icon: <UserCog aria-hidden />, show: can('accounts.read') },
      ],
    },
    {
      label: 'Administration',
      items: [
        { href: '/roles', label: 'Roles', icon: <ShieldCheck aria-hidden />, show: can('roles.read') },
        { href: '/settings', label: 'Settings', icon: <Settings aria-hidden />, show: can('settings.manage') },
        { href: '/audit', label: 'Audit log', icon: <ScrollText aria-hidden />, show: can('audit.read') },
      ],
    },
  ];
  const nav: NavGroup[] = groups
    .map((g) => ({ label: g.label, items: g.items.filter((i) => i.show).map(({ show: _show, ...item }) => item) }))
    .filter((g) => g.items.length > 0);
  const home = nav[0]?.items[0]?.href;

  const allowed = mayEnter(me);
  // The overview is the manager's: anyone else lands on their first section.
  const redirecting = ready && allowed && !isManager && pathname === '/' && home !== undefined && home !== '/';
  useEffect(() => {
    if (redirecting && home) router.replace(home);
  }, [redirecting, home, router]);

  async function signOut() {
    setSigningOut(true);
    await bffAuth('logout').catch(() => undefined);
    window.location.assign('/login');
  }

  let body: ReactNode;
  if (!ready) {
    body = meError ? <ErrorAlert error={meError} /> : <SkeletonRows rows={6} />;
  } else if (!allowed) {
    body = (
      <EmptyState title="No access" icon={<Lock aria-hidden />}>
        <p>
          Your role does not include the management dashboard. It is for compound managers and maintenance supervisors.
        </p>
        <Button onClick={() => void signOut()} loading={signingOut}>
          Sign out
        </Button>
      </EmptyState>
    );
  } else if (redirecting) {
    body = <SkeletonRows rows={6} />;
  } else if (!isManager && pathname === '/') {
    body = (
      <EmptyState title="Nothing here yet" icon={<Wrench aria-hidden />}>
        <p>Your role has no section in this dashboard yet.</p>
      </EmptyState>
    );
  } else {
    body = children;
  }

  return (
    <AppShell
      product="Jiwar Manager"
      context={session.data?.tenantName ?? 'Compound'}
      nav={ready && allowed ? nav : []}
      user={me ? { name: me.fullName ?? humanRole(me.type), meta: me.email ?? me.phone ?? '' } : null}
      onSignOut={signOut}
      signingOut={signingOut}
    >
      {body}
    </AppShell>
  );
}

function humanRole(type: string): string {
  return type === 'manager' ? 'Manager' : 'Staff';
}
