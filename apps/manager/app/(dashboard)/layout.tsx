'use client';

import { ErrorAlert } from '@jiwar/api/react';
import { AppShell, Button, EmptyState, SkeletonRows, type NavGroup, type NavItem } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import {
  Ban,
  Building,
  Car,
  CircleParking,
  ParkingMeter,
  Siren,
  Ticket,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  DoorOpen,
  Flag,
  HardHat,
  Handshake,
  Inbox,
  LayoutDashboard,
  Lightbulb,
  ListChecks,
  Lock,
  Megaphone,
  MessageSquareMore,
  MessagesSquare,
  Package,
  PackageSearch,
  ClipboardCheck,
  Dumbbell,
  IdCard,
  Receipt,
  Scale,
  ScrollText,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UserCog,
  Users,
  UserX,
  Vote,
  Wrench,
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { NotificationBell } from '@/components/notification-bell';
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
  const vehiclesToApprove = useQueueSize(
    keys.vehicles({ status: 'pending' }),
    () => fetchers.vehicles({ status: 'pending' }, undefined, 100),
    can('vehicles.manage'),
  );
  const appeals = useQueueSize(
    keys.fines({ status: 'under_appeal' }),
    () => fetchers.fines({ status: 'under_appeal' }, undefined, 100),
    can('fines.issue'),
  );
  const parkingReports = useQueueSize(
    keys.parkingReports('open'),
    () => fetchers.parkingReports('open', undefined, 100),
    can('parking_reports.handle'),
  );
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

  // Requests to the management nobody has taken yet (ADR 0039).
  const queued = useQueueSize(
    keys.managementRequests({ assignee: 'none', open: 'true' }),
    () => fetchers.managementRequests({ assignee: 'none', open: 'true' }, undefined, 100),
    can('requests.handle'),
  );

  // Suggestions nobody has looked at yet (ADR 0040).
  const received = useQueueSize(
    keys.suggestions({ status: 'received' }),
    () => fetchers.suggestions({ status: 'received', topicId: '', published: '' }, undefined, 100),
    can('community.suggestions'),
  );

  // Complaints between units nobody has taken yet, and reported
  // conversations still to be looked at (ADR 0042).
  const complaints = useQueueSize(
    keys.complaints({ status: 'submitted' }),
    () => fetchers.complaints({ status: 'submitted' }, undefined, 100),
    can('neighbours.handle'),
  );
  const reports = useQueueSize(
    keys.conversationReports('open'),
    () => fetchers.conversationReports('open', undefined, 100),
    can('neighbours.handle'),
  );

  // Bookings waiting for approval (ADR 0044).
  const approvals = useQueueSize(
    keys.bookings({ status: 'pending' }),
    () => fetchers.bookings({ status: 'pending' }, undefined, 100),
    can('bookings.handle'),
  );

  // Requests the system could not carry out by itself: a manager's to settle.
  const erasures = useQuery({
    queryKey: [...keys.erasures, 'count'],
    queryFn: () => fetchers.erasures(undefined, 100),
    refetchInterval: 120_000,
    retry: false,
    enabled: can('accounts.erase'),
  });
  const deletions = erasures.data?.data.filter((e) => e.status === 'queued').length ?? 0;

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
        {
          href: '/management-requests',
          label: 'Management requests',
          icon: <MessagesSquare aria-hidden />,
          count: queued,
          show: can('requests.handle'),
        },
        { href: '/appointments', label: 'Appointments', icon: <CalendarClock aria-hidden />, show: can('requests.handle') },
        { href: '/announcements', label: 'Announcements', icon: <Megaphone aria-hidden />, show: can('community.publish') },
        { href: '/events', label: 'Events', icon: <CalendarDays aria-hidden />, show: can('community.publish') },
        { href: '/polls', label: 'Polls', icon: <Vote aria-hidden />, show: can('community.publish') },
        {
          href: '/suggestions',
          label: 'Suggestions',
          icon: <Lightbulb aria-hidden />,
          count: received,
          show: can('community.suggestions'),
        },
        {
          href: '/complaints',
          label: 'Complaints',
          icon: <Scale aria-hidden />,
          count: complaints,
          show: can('neighbours.handle'),
        },
        { href: '/lost-found', label: 'Lost & found', icon: <PackageSearch aria-hidden />, show: can('neighbours.handle') },
        {
          href: '/conversation-reports',
          label: 'Conversation reports',
          icon: <Flag aria-hidden />,
          count: reports,
          show: can('neighbours.handle'),
        },
        {
          href: '/facilities',
          label: 'Facilities',
          icon: <Dumbbell aria-hidden />,
          show: can('facilities.manage') || can('bookings.handle'),
        },
        { href: '/bookings', label: 'Bookings', icon: <CalendarCheck aria-hidden />, exact: true, show: can('bookings.handle') },
        {
          href: '/bookings/approvals',
          label: 'Approvals',
          icon: <ClipboardCheck aria-hidden />,
          count: approvals,
          show: can('bookings.handle'),
        },
        { href: '/booking-suspensions', label: 'Suspensions', icon: <Ban aria-hidden />, show: can('bookings.handle') },
        { href: '/gate', label: 'Gate', icon: <DoorOpen aria-hidden />, show: can('gate.read') },
        { href: '/parcels', label: 'Parcels', icon: <Package aria-hidden />, show: can('parcels.manage') },
        { href: '/staff', label: 'Staff', icon: <UserCog aria-hidden />, show: can('accounts.read') },
      ],
    },
    {
      label: 'Vehicles & parking',
      items: [
        { href: '/vehicles', label: 'Vehicles', icon: <Car aria-hidden />, count: vehiclesToApprove, show: can('vehicles.manage') },
        { href: '/visitor-parking', label: 'Visitor parking', icon: <ParkingMeter aria-hidden />, show: can('vehicles.manage') },
        {
          href: '/fines',
          label: 'Fines',
          icon: <Ticket aria-hidden />,
          count: appeals,
          show: can('fines.issue') || can('fines.billing'),
        },
        {
          href: '/parking-reports',
          label: 'Parking reports',
          icon: <Siren aria-hidden />,
          count: parkingReports,
          show: can('parking_reports.handle'),
        },
        { href: '/parking', label: 'Parking setup', icon: <CircleParking aria-hidden />, show: can('vehicles.manage') },
      ],
    },
    {
      label: 'Club',
      items: [
        { href: '/club/memberships', label: 'Memberships', icon: <IdCard aria-hidden />, show: can('club.billing') },
        { href: '/club/plans', label: 'Plans', icon: <Receipt aria-hidden />, show: can('facilities.manage') || can('club.billing') },
      ],
    },
    {
      label: 'Administration',
      items: [
        { href: '/roles', label: 'Roles', icon: <ShieldCheck aria-hidden />, show: can('roles.read') },
        { href: '/settings', label: 'Settings', icon: <Settings aria-hidden />, show: can('settings.manage') },
        {
          href: '/maintenance-setup',
          label: 'Maintenance setup',
          icon: <SlidersHorizontal aria-hidden />,
          show: can('maintenance.manage'),
        },
        {
          href: '/management-setup',
          label: 'Requests setup',
          icon: <MessageSquareMore aria-hidden />,
          show: can('requests.manage'),
        },
        {
          href: '/community-setup',
          label: 'Community setup',
          icon: <ListChecks aria-hidden />,
          show: can('community.publish') || can('community.suggestions'),
        },
        {
          href: '/neighbours-setup',
          label: 'Neighbours setup',
          icon: <Handshake aria-hidden />,
          show: can('neighbours.manage'),
        },
        {
          href: '/deletions',
          label: 'Deletion requests',
          icon: <UserX aria-hidden />,
          count: deletions,
          show: can('accounts.erase'),
        },
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
      user={me ? { name: me.fullName ?? humanRole(me.type), meta: me.email ?? me.phone ?? '', href: allowed ? '/account' : undefined } : null}
      onSignOut={signOut}
      crumb={pathname === '/notifications' ? 'Notifications' : pathname === '/account' ? 'My account' : undefined}
      topbarEnd={ready && allowed ? <NotificationBell /> : null}
      signingOut={signingOut}
    >
      {body}
    </AppShell>
  );
}

function humanRole(type: string): string {
  return type === 'manager' ? 'Manager' : 'Staff';
}
