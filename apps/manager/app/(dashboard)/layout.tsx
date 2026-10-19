'use client';

import { ErrorAlert } from '@jiwar/api/react';
import { Alert, AppShell, Button, EmptyState, SkeletonRows, type NavGroup, type NavItem } from '@jiwar/ui';
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
  Banknote,
  CreditCard,
  FileText,
  LifeBuoy,
  CalendarRange,
  MessageSquareWarning,
  Undo2,
  BookOpen,
  ChartColumn,
  CalendarCog,
  ClipboardList,
  Repeat,
  BellRing,
  Briefcase,
  ClipboardPen,
  FileChartColumn,
  Gavel,
  Landmark,
  QrCode,
  Route,
  Footprints,
  ChartNoAxesColumn,
  ShieldAlert,
  ShieldBan,
  TriangleAlert,
  FileExclamationPoint,
  ChartPie,
  Baby,
  PiggyBank,
  Wallet,
  CloudOff,
  Smartphone,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { NotificationBell } from '@/components/notification-bell';
import { lockdownBanner } from '@/components/security/ops-logic';
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
  // Emergencies (ADR 0047): counted every ten seconds, not two minutes.
  const openEmergencies =
    useQuery({
      queryKey: [...keys.emergencies('open'), 'count'],
      queryFn: () => fetchers.emergencies('open', undefined, 100),
      refetchInterval: 10_000,
      retry: false,
      enabled: can('emergencies.manage') || can('emergencies.respond'),
    }).data?.data.length ?? 0;
  const gateServices = useQueueSize(
    keys.gateServices({ status: 'open' }),
    () => fetchers.gateServices({ status: 'open' }, undefined, 100),
    can('gate_services.handle'),
  );
  const electionsToCertify = useQueueSize(
    keys.governanceElections('closed'),
    () => fetchers.governanceElections('closed', undefined, 100),
    can('governance.manage'),
  );
  const permitsToDecide = useQueueSize(
    keys.permits({ status: 'pending', kind: '', live: false }),
    () => fetchers.permits({ status: 'pending' }, undefined, 100),
    can('permits.manage'),
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

  // A lockdown in force (ADR 0053): a banner on every page for whoever may
  // end it, polled as the emergencies are.
  const liveLockdowns =
    useQuery({
      queryKey: [...keys.lockdowns('live'), 'banner'],
      queryFn: () => fetchers.lockdowns('live', undefined, 100),
      refetchInterval: 10_000,
      retry: false,
      enabled: can('lockdown.end'),
    }).data?.data ?? [];
  const lockdownLine = lockdownBanner(liveLockdowns);
  // Violation appeals waiting for a decision (ADR 0053).
  const violationAppeals = useQueueSize(
    keys.violations({ status: 'under_appeal' }),
    () => fetchers.violations({ status: 'under_appeal' }, undefined, 100),
    can('violations.manage'),
  );
  // Incidents nobody investigates yet.
  const openIncidents = useQueueSize(
    keys.securityIncidents({ status: 'open' }),
    () => fetchers.securityIncidents({ status: 'open' }, undefined, 100),
    can('incidents.manage'),
  );

  // Field exceptions waiting for an answer (ADR 0056): minutes count here.
  const exceptionsWaiting =
    useQuery({
      queryKey: [...keys.fieldExceptions('pending'), 'count'],
      queryFn: () => fetchers.fieldExceptions('pending', undefined, 100),
      refetchInterval: 10_000,
      retry: false,
      enabled: can('gate_exceptions.decide'),
    }).data?.data.length ?? 0;

  // The gate offline (ADR 0057): security flags to look at, and
  // quarantined batches to decide.
  const offlineToLookAt =
    useQueueSize(
      keys.offlineFlags('open', 'security'),
      () => fetchers.offlineFlags('open', 'security', undefined, undefined, 100),
      can('gate_devices.manage'),
    ) +
    useQueueSize(
      keys.offlineBatches('pending'),
      () => fetchers.offlineBatches('pending', undefined, 100),
      can('gate_devices.manage'),
    );

  // Shift swaps the colleague accepted, to decide (ADR 0050).
  const swapsToDecide = useQueueSize(
    keys.swaps('accepted'),
    () => fetchers.swaps('accepted', undefined, 100),
    can('guard_roster.manage'),
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
      label: 'Safety',
      items: [
        {
          href: '/emergencies',
          label: 'Emergencies',
          icon: <Siren aria-hidden />,
          count: openEmergencies,
          show: can('emergencies.manage') || can('emergencies.respond'),
        },
        {
          href: '/gate-services',
          label: 'Gate services',
          icon: <LifeBuoy aria-hidden />,
          count: gateServices,
          show: can('gate_services.handle'),
        },
      ],
    },
    {
      label: 'Permits',
      items: [
        {
          href: '/permits',
          label: 'Permits',
          icon: <ClipboardCheck aria-hidden />,
          exact: true,
          count: permitsToDecide,
          show: can('permits.manage'),
        },
        { href: '/permits/materials', label: 'Materials log', icon: <Package aria-hidden />, show: can('permits.manage') },
        { href: '/permits/settings', label: 'Work hours', icon: <CalendarRange aria-hidden />, show: can('permits.manage') },
      ],
    },
    {
      label: 'Security',
      items: [
        { href: '/security/roster', label: 'Roster', icon: <CalendarCog aria-hidden />, show: can('guard_roster.manage') },
        {
          href: '/security/swaps',
          label: 'Shift swaps',
          icon: <Repeat aria-hidden />,
          count: swapsToDecide,
          show: can('guard_roster.manage'),
        },
        { href: '/security/handovers', label: 'Handovers', icon: <ClipboardPen aria-hidden />, show: can('guard_roster.manage') },
        { href: '/security/tasks', label: 'Guard tasks', icon: <ClipboardList aria-hidden />, show: can('guard_tasks.manage') },
        {
          href: '/security/instructions',
          label: 'Instructions',
          icon: <BellRing aria-hidden />,
          show: can('guard_instructions.manage'),
        },
        { href: '/security/found-items', label: 'Found at the gate', icon: <Briefcase aria-hidden />, show: can('found_items.manage') },
        { href: '/security/reports', label: 'Daily report', icon: <FileChartColumn aria-hidden />, show: can('guard_reports.read') },
        // Patrols (ADR 0052).
        { href: '/security/patrols/checkpoints', label: 'Checkpoints', icon: <QrCode aria-hidden />, show: can('patrols.manage') },
        { href: '/security/patrols/routes', label: 'Patrol routes', icon: <Route aria-hidden />, show: can('patrols.manage') },
        {
          href: '/security/patrols/runs',
          label: 'Patrol runs',
          icon: <Footprints aria-hidden />,
          show: can('patrols.manage') || can('guard_reports.read'),
        },
        {
          href: '/security/patrols/report',
          label: 'Patrol report',
          icon: <ChartNoAxesColumn aria-hidden />,
          show: can('patrols.manage') || can('guard_reports.read'),
        },
        // Incidents, the blocklist, the lockdown and violations (ADR 0053).
        {
          href: '/security/lockdowns',
          label: 'Lockdown',
          icon: <ShieldAlert aria-hidden />,
          count: liveLockdowns.length,
          show: can('lockdown.end'),
        },
        { href: '/security/blocklist', label: 'Blocklist', icon: <ShieldBan aria-hidden />, show: can('blocklist.manage') },
        {
          href: '/security/incidents',
          label: 'Incidents',
          icon: <TriangleAlert aria-hidden />,
          count: openIncidents,
          show: can('incidents.manage'),
        },
        {
          href: '/violations',
          label: 'Violations',
          icon: <FileExclamationPoint aria-hidden />,
          count: violationAppeals,
          show: can('violations.manage') || can('violations.issue') || can('fines.billing'),
        },
        {
          href: '/security/summary',
          label: 'Incidents & violations report',
          icon: <ChartPie aria-hidden />,
          show: can('incidents.manage') || can('violations.manage') || can('guard_reports.read'),
        },
        // Children (ADR 0054): unauthorized pickups, for the keepers.
        { href: '/security/child-alerts', label: 'Child alerts', icon: <Baby aria-hidden />, show: can('guard_roster.manage') },
        // The gate's completion (ADR 0056).
        {
          href: '/security/field-exceptions',
          label: 'Field exceptions',
          icon: <DoorOpen aria-hidden />,
          count: exceptionsWaiting,
          show: can('gate_exceptions.decide'),
        },
        { href: '/security/gate-settings', label: 'Gate settings', icon: <SlidersHorizontal aria-hidden />, show: can('gate.manage') },
        // The gate offline (ADR 0057).
        { href: '/security/gate-devices', label: 'Gate devices', icon: <Smartphone aria-hidden />, show: can('gate_devices.manage') },
        {
          href: '/security/offline-flags',
          label: 'Offline flags',
          icon: <CloudOff aria-hidden />,
          count: offlineToLookAt,
          show: can('gate_devices.manage'),
        },
      ],
    },
    {
      label: 'Governance',
      items: [
        { href: '/governance/board', label: 'Board', icon: <Landmark aria-hidden />, show: can('governance.manage') },
        { href: '/governance/polls', label: 'Owners’ polls', icon: <Vote aria-hidden />, show: can('governance.manage') },
        {
          href: '/governance/elections',
          label: 'Elections',
          icon: <Gavel aria-hidden />,
          count: electionsToCertify,
          show: can('governance.manage'),
        },
        { href: '/governance/decisions', label: 'Decisions', icon: <ScrollText aria-hidden />, show: can('governance.manage') },
        // Board matters (ADR 0055): the management's side; never a motion or a vote.
        { href: '/governance/approvals', label: 'Approvals', icon: <ClipboardCheck aria-hidden />, show: can('governance.approvals') },
        { href: '/governance/board-appeals', label: 'Appeals to the board', icon: <Scale aria-hidden />, show: can('governance.manage') },
        { href: '/governance/settings', label: 'Board settings', icon: <SlidersHorizontal aria-hidden />, show: can('governance.manage') },
      ],
    },
    {
      // A sitting member's own (ADR 0055): what the board decides.
      label: 'The board',
      items: [
        { href: '/board/approvals', label: 'Inbox', icon: <Inbox aria-hidden />, show: can('governance.board') },
        { href: '/board/appeals', label: 'Appeals', icon: <Scale aria-hidden />, show: can('governance.board') },
        { href: '/board/overview', label: 'Overview', icon: <LayoutDashboard aria-hidden />, show: can('governance.board') },
      ],
    },
    {
      label: 'Finance',
      items: [
        { href: '/finance/invoices', label: 'Invoices', icon: <FileText aria-hidden />, show: can('finance.invoice') },
        { href: '/finance/instalments', label: 'Instalment plans', icon: <CalendarRange aria-hidden />, show: can('finance.invoice') },
        { href: '/finance/disputes', label: 'Disputes', icon: <MessageSquareWarning aria-hidden />, show: can('finance.invoice') },
        { href: '/finance/payments', label: 'Payments', icon: <Banknote aria-hidden />, show: can('finance.payments') },
        { href: '/finance/plans', label: 'Billing plans', icon: <CalendarClock aria-hidden />, show: can('finance.billing') || can('finance.invoice') },
        { href: '/finance/refunds', label: 'Refunds', icon: <Undo2 aria-hidden />, show: can('finance.refund') },
        { href: '/finance/ledger', label: 'Ledger', icon: <BookOpen aria-hidden />, show: can('finance.reports') },
        { href: '/finance/reports', label: 'Reports', icon: <ChartColumn aria-hidden />, show: can('finance.reports') },
        { href: '/finance/budgets', label: 'Budgets', icon: <PiggyBank aria-hidden />, show: can('finance.budget') },
        { href: '/finance/expenses', label: 'Expenses', icon: <Wallet aria-hidden />, show: can('finance.budget') },
        { href: '/finance/gateway', label: 'Online payments', icon: <CreditCard aria-hidden />, show: can('finance.gateway') },
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
    body = (
      <>
        {lockdownLine && pathname !== '/security/lockdowns' ? (
          <Alert tone="error">
            {lockdownLine}. <Link href="/security/lockdowns">End it or read its overrides</Link>
          </Alert>
        ) : null}
        {children}
      </>
    );
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
