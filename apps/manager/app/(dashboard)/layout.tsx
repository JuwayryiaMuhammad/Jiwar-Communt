'use client';

import { ErrorAlert } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Alert, AppShell, Button, EmptyState, SkeletonRows, useCommonT, type NavGroup, type NavItem } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import {
  Ban,
  Boxes,
  CalendarSync,
  MapPinned,
  RefreshCcw,
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
  MonitorDot,
  Watch,
  Gauge,
  Zap,
  ZapOff,
  ShoppingBag,
  Tag,
  Sun,
  Newspaper,
  Search,
  Map as MapIcon,
  LayoutGrid,
  CalendarOff,
  TreePine,
  HeartPulse,
  HandCoins,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { NotificationBell } from '@/components/notification-bell';
import { StaffSearch } from '@/components/staff-search';
import { lockdownBanner } from '@/components/security/ops-logic';
import { mayEnter } from '@/lib/access';
import { bffAuth } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/shell-layout';
import en from '@/messages/en/shell-layout';

/** A queue's size for the sidebar; not asked for by a role without access. */
function useQueueSize(key: readonly unknown[], fetch: () => Promise<{ data: unknown[] }>, enabled: boolean) {
  const q = useQuery({ queryKey: [...key, 'count'], queryFn: fetch, refetchInterval: 120_000, retry: false, enabled });
  return q.data?.data.length ?? 0;
}

type GatedItem = NavItem & { show: boolean };

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
      items: [
        // The operations dashboard (ADR 0079): each card to its own permission.
        {
          href: '/',
          label: t('nav.overview'),
          icon: <LayoutDashboard aria-hidden />,
          exact: true,
          show: isManager || can('dashboard.read'),
        },
        // What waits for my decision, across the compound (ADR 0073).
        { href: '/inbox', label: t('nav.inbox'), icon: <Inbox aria-hidden />, show: can('inbox.read') },
        { href: '/briefs', label: t('nav.briefs'), icon: <Newspaper aria-hidden />, show: can('dashboard.read') },
      ],
    },
    {
      label: t('group.community'),
      items: [
        {
          href: '/requests',
          label: t('nav.requests'),
          icon: <Inbox aria-hidden />,
          count: registrations + household,
          show: can('residents.manage') || can('household.approve'),
        },
        { href: '/units', label: t('nav.units'), icon: <Building aria-hidden />, show: isManager && can('units.read') },
        { href: '/residents', label: t('nav.residents'), icon: <Users aria-hidden />, show: can('residents.read') },
        { href: '/identity-changes', label: t('nav.identity-changes'), icon: <Users aria-hidden />, show: can('residents.manage') },
        { href: '/contract-renewals', label: t('nav.contract-renewals'), icon: <FileText aria-hidden />, show: can('contracts.manage') },
        { href: '/moves', label: t('nav.moves'), icon: <Building aria-hidden />, show: can('residents.manage') },
        // ADR 0083.
        { href: '/ownership-transfers', label: t('nav.ownership-transfers'), icon: <Building aria-hidden />, show: can('residents.manage') },
        { href: '/compound-documents', label: t('nav.compound-documents'), icon: <BookOpen aria-hidden />, show: can('content.manage') },
        {
          href: '/workers',
          label: t('nav.workers'),
          icon: <HardHat aria-hidden />,
          count: workers,
          show: can('workers.review') || can('workers.compliance') || can('workers.incidents'),
        },
      ],
    },
    {
      // The asset register, its plans and inspections (ADR 0064).
      label: t('group.assets'),
      items: [
        { href: '/assets', label: t('nav.assets'), icon: <Boxes aria-hidden />, show: can('assets.read') },
        { href: '/areas', label: t('nav.areas'), icon: <MapPinned aria-hidden />, show: can('assets.read') },
        {
          href: '/maintenance-plans',
          label: t('nav.maintenance-plans'),
          icon: <CalendarSync aria-hidden />,
          show: can('assets.read'),
        },
        // The planned work across every plan, and warranty claims (ADR 0076).
        { href: '/plan-calendar', label: t('nav.plan-calendar'), icon: <CalendarSync aria-hidden />, show: can('assets.read') },
        { href: '/warranty-claims', label: t('nav.warranty-claims'), icon: <ShieldCheck aria-hidden />, show: can('assets.manage') },
        { href: '/inspections', label: t('nav.inspections'), icon: <ClipboardCheck aria-hidden />, show: can('inspections.manage') },
        {
          href: '/replacement-recommendations',
          label: t('nav.replacement-recommendations'),
          icon: <RefreshCcw aria-hidden />,
          show: can('assets.manage'),
        },
        // The store, contracts and what it all cost (ADR 0065).
        { href: '/stock', label: t('nav.stock'), icon: <Package aria-hidden />, show: can('stock.manage') },
        { href: '/contracts', label: t('nav.contracts'), icon: <Handshake aria-hidden />, show: can('assets.manage') },
        { href: '/vendors', label: t('nav.vendors'), icon: <Handshake aria-hidden />, show: can('vendors.manage') },
        // Tenders and their opening by two people (ADR 0088).
        { href: '/tenders', label: t('nav.tenders'), icon: <Handshake aria-hidden />, show: can('tenders.manage') || can('tenders.open') },
        {
          href: '/purchases',
          label: t('nav.purchases'),
          icon: <Handshake aria-hidden />,
          show: can('purchases.approve') || can('purchases.request'),
        },
        { href: '/economics', label: t('nav.economics'), icon: <Receipt aria-hidden />, show: can('assets.manage') },
        // Energy and utilities (ADR 0066).
        { href: '/meters', label: t('nav.meters'), icon: <Gauge aria-hidden />, show: can('energy.read') },
        { href: '/energy', label: t('nav.energy'), icon: <Zap aria-hidden />, show: can('energy.read') },
        { href: '/outages', label: t('nav.outages'), icon: <ZapOff aria-hidden />, show: can('energy.read') },
        // Readiness and field safety (ADR 0067).
        { href: '/readiness', label: t('nav.readiness'), icon: <CalendarCheck aria-hidden />, show: can('readiness.manage') },
        { href: '/work-permits', label: t('nav.work-permits'), icon: <HardHat aria-hidden />, show: can('safety.manage') },
        // Compliance (ADR 0087).
        { href: '/compliance', label: t('nav.compliance'), icon: <CalendarCheck aria-hidden />, show: can('compliance.manage') },
        {
          href: '/compliance/calendar',
          label: t('nav.compliance.calendar'),
          icon: <CalendarCheck aria-hidden />,
          show: can('compliance.manage'),
        },
        // The field team (ADR 0078).
        { href: '/field-team', label: t('nav.field-team'), icon: <HardHat aria-hidden />, show: can('field_team.manage') },
      ],
    },
    {
      label: t('group.operations'),
      items: [
        {
          href: '/maintenance',
          label: t('nav.maintenance'),
          icon: <Wrench aria-hidden />,
          count: unassigned,
          show: can('tickets.dispatch'),
        },
        // Whether the SLA was kept (ADR 0076).
        { href: '/sla-report', label: t('nav.sla-report'), icon: <Gauge aria-hidden />, show: can('tickets.dispatch') },
        // Maintenance analytics and cases (ADR 0081).
        { href: '/recurrence', label: t('nav.recurrence'), icon: <Repeat aria-hidden />, show: can('tickets.dispatch') },
        { href: '/complaints-map', label: t('nav.complaints-map'), icon: <MapPinned aria-hidden />, show: can('tickets.dispatch') },
        { href: '/cases', label: t('nav.cases'), icon: <Users aria-hidden />, show: can('tickets.dispatch') },
        {
          href: '/management-requests',
          label: t('nav.management-requests'),
          icon: <MessagesSquare aria-hidden />,
          count: queued,
          show: can('requests.handle'),
        },
        { href: '/appointments', label: t('nav.appointments'), icon: <CalendarClock aria-hidden />, show: can('requests.handle') },
        // Experience and recovery (ADR 0082): the cases and signals, the compensations, the setup and the reports.
        { href: '/experience', label: t('nav.experience'), icon: <HeartPulse aria-hidden />, show: can('experience.manage') },
        { href: '/experience/compensations', label: t('nav.experience.compensations'), icon: <HandCoins aria-hidden />, show: can('experience.manage') },
        // A staff decision appealed by those it is about (ADR 0059).
        { href: '/appeals', label: t('nav.appeals'), icon: <Gavel aria-hidden />, show: can('appeals.decide') },
        { href: '/announcements', label: t('nav.announcements'), icon: <Megaphone aria-hidden />, show: can('community.publish') },
        // ADR 0080: the office's templates and letters.
        { href: '/message-templates', label: t('nav.message-templates'), icon: <Megaphone aria-hidden />, show: can('community.publish') || can('requests.manage') },
        { href: '/official-letters', label: t('nav.official-letters'), icon: <MessagesSquare aria-hidden />, show: can('letters.issue') },
        { href: '/events', label: t('nav.events'), icon: <CalendarDays aria-hidden />, show: can('community.publish') },
        { href: '/polls', label: t('nav.polls'), icon: <Vote aria-hidden />, show: can('community.publish') },
        {
          href: '/suggestions',
          label: t('nav.suggestions'),
          icon: <Lightbulb aria-hidden />,
          count: received,
          show: can('community.suggestions'),
        },
        {
          href: '/complaints',
          label: t('nav.complaints'),
          icon: <Scale aria-hidden />,
          count: complaints,
          show: can('neighbours.handle'),
        },
        { href: '/lost-found', label: t('nav.lost-found'), icon: <PackageSearch aria-hidden />, show: can('neighbours.handle') },
        {
          href: '/conversation-reports',
          label: t('nav.conversation-reports'),
          icon: <Flag aria-hidden />,
          count: reports,
          show: can('neighbours.handle'),
        },
        // The market: review, reports, shops; group and partner offers (ADR 0071).
        { href: '/market', label: t('nav.market'), icon: <ShoppingBag aria-hidden />, exact: true, show: can('market.handle') },
        { href: '/market/offers', label: t('nav.market.offers'), icon: <Tag aria-hidden />, show: can('market.handle') || can('partners.manage') },
        // Prayer times, buses and the gallery (ADR 0071).
        { href: '/daily-life', label: t('nav.daily-life'), icon: <Sun aria-hidden />, show: can('content.manage') },
        {
          href: '/facilities',
          label: t('nav.facilities'),
          icon: <Dumbbell aria-hidden />,
          show: can('facilities.manage') || can('bookings.handle'),
        },
        { href: '/bookings', label: t('nav.bookings'), icon: <CalendarCheck aria-hidden />, exact: true, show: can('bookings.handle') },
        {
          href: '/bookings/approvals',
          label: t('nav.bookings.approvals'),
          icon: <ClipboardCheck aria-hidden />,
          count: approvals,
          show: can('bookings.handle'),
        },
        { href: '/booking-suspensions', label: t('nav.booking-suspensions'), icon: <Ban aria-hidden />, show: can('bookings.handle') },
        // Facility bans and use (ADR 0067).
        { href: '/facility-bans', label: t('nav.facility-bans'), icon: <UserX aria-hidden />, show: can('bookings.handle') },
        {
          href: '/facility-usage',
          label: t('nav.facility-usage'),
          icon: <ChartColumn aria-hidden />,
          show: can('facilities.manage') || can('bookings.handle'),
        },
        // Spaces (ADR 0084).
        {
          href: '/space-uses',
          label: t('nav.space-uses'),
          icon: <TreePine aria-hidden />,
          show: can('bookings.handle') || can('spaces.manage'),
        },
        { href: '/holidays', label: t('nav.holidays'), icon: <CalendarOff aria-hidden />, show: can('spaces.manage') },
        { href: '/site-map', label: t('nav.site-map'), icon: <MapIcon aria-hidden />, show: can('spaces.manage') },
        { href: '/floor-plans', label: t('nav.floor-plans'), icon: <LayoutGrid aria-hidden />, show: can('spaces.manage') },
        { href: '/gate', label: t('nav.gate'), icon: <DoorOpen aria-hidden />, exact: true, show: can('gate.read') },
        // The gate's traffic and its log search (ADR 0056, 0079).
        { href: '/gate/traffic', label: t('nav.gate.traffic'), icon: <ChartColumn aria-hidden />, show: can('gate.read') },
        { href: '/gate/log-search', label: t('nav.gate.log-search'), icon: <Search aria-hidden />, show: can('gate_log.search') },
        { href: '/parcels', label: t('nav.parcels'), icon: <Package aria-hidden />, show: can('parcels.manage') },
        { href: '/staff', label: t('nav.staff'), icon: <UserCog aria-hidden />, show: can('accounts.read') },
        // Dangling accounts and access reviews (ADR 0090).
        { href: '/access-checks', label: t('nav.access-checks'), icon: <UserCog aria-hidden />, show: can('accounts.manage') },
      ],
    },
    {
      label: t('group.vehicles-and-parking'),
      items: [
        { href: '/vehicles', label: t('nav.vehicles'), icon: <Car aria-hidden />, count: vehiclesToApprove, show: can('vehicles.manage') },
        { href: '/visitor-parking', label: t('nav.visitor-parking'), icon: <ParkingMeter aria-hidden />, show: can('vehicles.manage') },
        {
          href: '/fines',
          label: t('nav.fines'),
          icon: <Ticket aria-hidden />,
          count: appeals,
          show: can('fines.issue') || can('fines.billing'),
        },
        {
          href: '/parking-reports',
          label: t('nav.parking-reports'),
          icon: <Siren aria-hidden />,
          count: parkingReports,
          show: can('parking_reports.handle'),
        },
        { href: '/parking', label: t('nav.parking'), icon: <CircleParking aria-hidden />, show: can('vehicles.manage') },
      ],
    },
    {
      label: t('group.safety'),
      items: [
        {
          href: '/emergencies',
          label: t('nav.emergencies'),
          icon: <Siren aria-hidden />,
          count: openEmergencies,
          show: can('emergencies.manage') || can('emergencies.respond'),
        },
        {
          href: '/gate-services',
          label: t('nav.gate-services'),
          icon: <LifeBuoy aria-hidden />,
          count: gateServices,
          show: can('gate_services.handle'),
        },
      ],
    },
    {
      label: t('group.permits'),
      items: [
        {
          href: '/permits',
          label: t('nav.permits'),
          icon: <ClipboardCheck aria-hidden />,
          exact: true,
          count: permitsToDecide,
          show: can('permits.manage'),
        },
        { href: '/permits/materials', label: t('nav.permits.materials'), icon: <Package aria-hidden />, show: can('permits.manage') },
        { href: '/permits/inspections', label: t('nav.permits.inspections'), icon: <ClipboardPen aria-hidden />, show: can('permits.manage') },
        { href: '/permits/settings', label: t('nav.permits.settings'), icon: <CalendarRange aria-hidden />, show: can('permits.manage') },
      ],
    },
    {
      // The compound's service partners (ADR 0060).
      label: t('group.partners'),
      items: [
        { href: '/partners', label: t('nav.partners'), icon: <Handshake aria-hidden />, exact: true, show: can('partners.manage') },
        { href: '/partners/requests', label: t('nav.partners.requests'), icon: <Inbox aria-hidden />, show: can('partners.manage') },
        { href: '/partners/complaints', label: t('nav.partners.complaints'), icon: <Scale aria-hidden />, show: can('partners.manage') },
        { href: '/partners/settings', label: t('nav.partners.settings'), icon: <SlidersHorizontal aria-hidden />, show: can('partners.manage') },
      ],
    },
    {
      label: t('group.security'),
      items: [
        { href: '/security/roster', label: t('nav.security.roster'), icon: <CalendarCog aria-hidden />, show: can('guard_roster.manage') },
        {
          href: '/security/swaps',
          label: t('nav.security.swaps'),
          icon: <Repeat aria-hidden />,
          count: swapsToDecide,
          show: can('guard_roster.manage'),
        },
        { href: '/security/handovers', label: t('nav.security.handovers'), icon: <ClipboardPen aria-hidden />, show: can('guard_roster.manage') },
        { href: '/security/tasks', label: t('nav.security.tasks'), icon: <ClipboardList aria-hidden />, show: can('guard_tasks.manage') },
        { href: '/security/inspection-requests', label: t('nav.security.inspection-requests'), icon: <ClipboardList aria-hidden />, show: can('guard_tasks.manage') },
        // ADR 0083.
        { href: '/security/closed-units', label: t('nav.security.closed-units'), icon: <ClipboardList aria-hidden />, show: can('guard_tasks.manage') },
        { href: '/security/unit-entries', label: t('nav.security.unit-entries'), icon: <ClipboardPen aria-hidden />, show: can('guard_tasks.manage') },
        {
          href: '/security/instructions',
          label: t('nav.security.instructions'),
          icon: <BellRing aria-hidden />,
          show: can('guard_instructions.manage'),
        },
        { href: '/security/found-items', label: t('nav.security.found-items'), icon: <Briefcase aria-hidden />, show: can('found_items.manage') },
        { href: '/security/reports', label: t('nav.security.reports'), icon: <FileChartColumn aria-hidden />, show: can('guard_reports.read') },
        // Patrols (ADR 0052).
        { href: '/security/patrols/checkpoints', label: t('nav.security.patrols.checkpoints'), icon: <QrCode aria-hidden />, show: can('patrols.manage') },
        { href: '/security/patrols/routes', label: t('nav.security.patrols.routes'), icon: <Route aria-hidden />, show: can('patrols.manage') },
        {
          href: '/security/patrols/runs',
          label: t('nav.security.patrols.runs'),
          icon: <Footprints aria-hidden />,
          show: can('patrols.manage') || can('guard_reports.read'),
        },
        {
          href: '/security/patrols/report',
          label: t('nav.security.patrols.report'),
          icon: <ChartNoAxesColumn aria-hidden />,
          show: can('patrols.manage') || can('guard_reports.read'),
        },
        // Incidents, the blocklist, the lockdown and violations (ADR 0053).
        {
          href: '/security/lockdowns',
          label: t('nav.security.lockdowns'),
          icon: <ShieldAlert aria-hidden />,
          count: liveLockdowns.length,
          show: can('lockdown.end') || can('lockdown.start'),
        },
        { href: '/security/blocklist', label: t('nav.security.blocklist'), icon: <ShieldBan aria-hidden />, show: can('blocklist.manage') },
        {
          href: '/security/incidents',
          label: t('nav.security.incidents'),
          icon: <TriangleAlert aria-hidden />,
          count: openIncidents,
          show: can('incidents.manage'),
        },
        {
          href: '/violations',
          label: t('nav.violations'),
          icon: <FileExclamationPoint aria-hidden />,
          count: violationAppeals,
          show: can('violations.manage') || can('violations.issue') || can('fines.billing'),
        },
        {
          href: '/security/summary',
          label: t('nav.security.summary'),
          icon: <ChartPie aria-hidden />,
          show: can('incidents.manage') || can('violations.manage') || can('guard_reports.read'),
        },
        // Safety KPIs and the owner's corrective actions (ADR 0087).
        {
          href: '/security/safety',
          label: t('nav.security.safety'),
          icon: <ChartPie aria-hidden />,
          show: can('incidents.manage') || can('guard_reports.read'),
        },
        { href: '/my-actions', label: t('nav.my-actions'), icon: <TriangleAlert aria-hidden />, show: true },
        // Children (ADR 0054): unauthorized pickups, for the keepers.
        { href: '/security/child-alerts', label: t('nav.security.child-alerts'), icon: <Baby aria-hidden />, show: can('guard_roster.manage') },
        // The gate's completion (ADR 0056).
        {
          href: '/security/field-exceptions',
          label: t('nav.security.field-exceptions'),
          icon: <DoorOpen aria-hidden />,
          count: exceptionsWaiting,
          show: can('gate_exceptions.decide'),
        },
        { href: '/security/gate-settings', label: t('nav.security.gate-settings'), icon: <SlidersHorizontal aria-hidden />, show: can('gate.manage') },
        // The gate offline (ADR 0057).
        { href: '/security/gate-devices', label: t('nav.security.gate-devices'), icon: <Smartphone aria-hidden />, show: can('gate_devices.manage') },
        // Guard vendors (ADR 0068): the control room and the guard-down wearables.
        { href: '/security/control-room', label: t('nav.security.control-room'), icon: <MonitorDot aria-hidden />, show: can('control_room.watch') },
        { href: '/security/alarm-devices', label: t('nav.security.alarm-devices'), icon: <Watch aria-hidden />, show: can('gate_devices.manage') },
        {
          href: '/security/offline-flags',
          label: t('nav.security.offline-flags'),
          icon: <CloudOff aria-hidden />,
          count: offlineToLookAt,
          show: can('gate_devices.manage'),
        },
      ],
    },
    {
      label: t('group.governance'),
      items: [
        { href: '/governance/board', label: t('nav.governance.board'), icon: <Landmark aria-hidden />, show: can('governance.manage') },
        { href: '/governance/polls', label: t('nav.governance.polls'), icon: <Vote aria-hidden />, show: can('governance.manage') },
        {
          href: '/governance/elections',
          label: t('nav.governance.elections'),
          icon: <Gavel aria-hidden />,
          count: electionsToCertify,
          show: can('governance.manage'),
        },
        { href: '/governance/decisions', label: t('nav.governance.decisions'), icon: <ScrollText aria-hidden />, show: can('governance.manage') },
        // Board matters (ADR 0055): the management's side; never a motion or a vote.
        { href: '/governance/approvals', label: t('nav.governance.approvals'), icon: <ClipboardCheck aria-hidden />, show: can('governance.approvals') },
        { href: '/governance/board-appeals', label: t('nav.governance.board-appeals'), icon: <Scale aria-hidden />, show: can('governance.manage') },
        { href: '/governance/settings', label: t('nav.governance.settings'), icon: <SlidersHorizontal aria-hidden />, show: can('governance.manage') },
        // The board's work (ADR 0075): shares for weighted polls, the rules, the manager's handover.
        { href: '/governance/unit-shares', label: t('nav.governance.unit-shares'), icon: <Vote aria-hidden />, show: can('governance.manage') },
        { href: '/governance/rules', label: t('nav.governance.rules'), icon: <SlidersHorizontal aria-hidden />, show: can('governance.manage') },
        { href: '/governance/handover', label: t('nav.governance.handover'), icon: <ScrollText aria-hidden />, show: can('governance.manage') },
      ],
    },
    {
      // A sitting member's own (ADR 0055): what the board decides.
      label: t('group.the-board'),
      items: [
        { href: '/board/approvals', label: t('nav.board.approvals'), icon: <Inbox aria-hidden />, show: can('governance.board') },
        { href: '/board/appeals', label: t('nav.board.appeals'), icon: <Scale aria-hidden />, show: can('governance.board') },
        { href: '/board/overview', label: t('nav.board.overview'), icon: <LayoutDashboard aria-hidden />, show: can('governance.board') },
        // The owners' voice (ADR 0059): representatives by the board's motions; proposals and objections answered once.
        { href: '/board/representatives', label: t('nav.board.representatives'), icon: <Users aria-hidden />, show: can('governance.board') },
        { href: '/board/agenda', label: t('nav.board.agenda'), icon: <Lightbulb aria-hidden />, show: can('governance.board') },
        { href: '/board/objections', label: t('nav.board.objections'), icon: <MessageSquareWarning aria-hidden />, show: can('governance.board') },
        // The board's work (ADR 0075): meetings, handovers and the monthly report; the manager reads them too.
        { href: '/board/meetings', label: t('nav.board.meetings'), icon: <CalendarClock aria-hidden />, show: can('governance.board') || can('governance.manage') },
        { href: '/board/handover', label: t('nav.board.handover'), icon: <ScrollText aria-hidden />, show: can('governance.board') || can('governance.manage') },
        { href: '/board/reports', label: t('nav.board.reports'), icon: <ChartColumn aria-hidden />, show: can('governance.board') || can('governance.manage') },
      ],
    },
    {
      label: t('group.finance'),
      items: [
        { href: '/finance/invoices', label: t('nav.finance.invoices'), icon: <FileText aria-hidden />, show: can('finance.invoice') },
        { href: '/finance/instalments', label: t('nav.finance.instalments'), icon: <CalendarRange aria-hidden />, show: can('finance.invoice') },
        // Payment plans residents ask for, and the terms for them (ADR 0069).
        { href: '/finance/plan-requests', label: t('nav.finance.plan-requests'), icon: <CalendarRange aria-hidden />, show: can('finance.invoice') },
        { href: '/finance/disputes', label: t('nav.finance.disputes'), icon: <MessageSquareWarning aria-hidden />, show: can('finance.invoice') },
        // The formal late-payment notices and their proofs (ADR 0058).
        { href: '/finance/late-notices', label: t('nav.finance.late-notices'), icon: <Scale aria-hidden />, show: can('finance.invoice') },
        { href: '/finance/payments', label: t('nav.finance.payments'), icon: <Banknote aria-hidden />, show: can('finance.payments') },
        // Field collectors' visits and their margin (ADR 0069).
        { href: '/finance/collector-visits', label: t('nav.finance.collector-visits'), icon: <Banknote aria-hidden />, show: can('finance.payments') },
        { href: '/finance/custody', label: t('nav.finance.custody'), icon: <Banknote aria-hidden />, show: can('finance.payments') || can('finance.custody') },
        { href: '/finance/cheques', label: t('nav.finance.cheques'), icon: <Banknote aria-hidden />, show: can('finance.payments') },
        { href: '/finance/treasury', label: t('nav.finance.treasury'), icon: <Wallet aria-hidden />, show: can('finance.treasury') },
        { href: '/finance/statements', label: t('nav.finance.statements'), icon: <BookOpen aria-hidden />, show: can('finance.treasury') },
        // The cash flow forecast and liquidity (ADR 0091).
        { href: '/finance/cash-flow', label: t('nav.finance.cash-flow'), icon: <ChartColumn aria-hidden />, show: can('finance.cashflow') },
        { href: '/finance/plans', label: t('nav.finance.plans'), icon: <CalendarClock aria-hidden />, show: can('finance.billing') || can('finance.invoice') },
        { href: '/finance/refunds', label: t('nav.finance.refunds'), icon: <Undo2 aria-hidden />, show: can('finance.refund') },
        { href: '/finance/ledger', label: t('nav.finance.ledger'), icon: <BookOpen aria-hidden />, show: can('finance.reports') },
        // The general ledger, double entry (ADR 0092).
        { href: '/finance/gl', label: t('nav.finance.gl'), icon: <BookOpen aria-hidden />, show: can('finance.ledger') },
        { href: '/finance/gl/statements', label: t('nav.finance.gl.statements'), icon: <ChartColumn aria-hidden />, show: can('finance.ledger') },
        { href: '/finance/gl/entries', label: t('nav.finance.gl.entries'), icon: <BookOpen aria-hidden />, show: can('finance.ledger') },
        { href: '/finance/gl/periods', label: t('nav.finance.gl.periods'), icon: <CalendarClock aria-hidden />, show: can('finance.ledger') },
        // Taxes (ADR 0093).
        { href: '/finance/tax', label: t('nav.finance.tax'), icon: <Landmark aria-hidden />, show: can('finance.ledger') },
        { href: '/finance/tax/vat', label: t('nav.finance.tax.vat'), icon: <Receipt aria-hidden />, show: can('finance.ledger') },
        { href: '/finance/tax/withholding', label: t('nav.finance.tax.withholding'), icon: <Receipt aria-hidden />, show: can('finance.ledger') },
        { href: '/finance/reports', label: t('nav.finance.reports'), icon: <ChartColumn aria-hidden />, show: can('finance.reports') },
        // Where the fees went, published to every payer (ADR 0069).
        { href: '/finance/spending-reports', label: t('nav.finance.spending-reports'), icon: <PiggyBank aria-hidden />, show: can('finance.reports') || can('finance.budget') },
        { href: '/finance/budgets', label: t('nav.finance.budgets'), icon: <PiggyBank aria-hidden />, show: can('finance.budget') },
        { href: '/finance/expenses', label: t('nav.finance.expenses'), icon: <Wallet aria-hidden />, show: can('finance.budget') },
        {
          href: '/finance/budget-planning',
          label: t('nav.finance.budget-planning'),
          icon: <PiggyBank aria-hidden />,
          show: can('finance.budget'),
        },
        {
          href: '/finance/payables',
          label: t('nav.finance.payables'),
          icon: <Wallet aria-hidden />,
          show: can('finance.payables') || can('finance.payables_approve'),
        },
        { href: '/finance/gateway', label: t('nav.finance.gateway'), icon: <CreditCard aria-hidden />, show: can('finance.gateway') },
      ],
    },
    {
      label: t('group.club'),
      items: [
        { href: '/club/memberships', label: t('nav.club.memberships'), icon: <IdCard aria-hidden />, show: can('club.billing') },
        { href: '/club/plans', label: t('nav.club.plans'), icon: <Receipt aria-hidden />, show: can('facilities.manage') || can('club.billing') },
        { href: '/club/requests', label: t('nav.club.requests'), icon: <Receipt aria-hidden />, show: can('club.billing') },
      ],
    },
    {
      // The reports platform (ADR 0086): each report by its own permission.
      label: t('group.reports'),
      items: [
        {
          href: '/reports',
          label: t('nav.reports'),
          icon: <ChartColumn aria-hidden />,
          show: ['assets.manage', 'stock.manage', 'tickets.dispatch', 'energy.read', 'finance.reports'].some((p) => can(p)),
        },
        { href: '/reports/schedules', label: t('nav.reports.schedules'), icon: <CalendarClock aria-hidden />, show: can('reports.schedule') },
        {
          href: '/reports/runs',
          label: t('nav.reports.runs'),
          icon: <FileChartColumn aria-hidden />,
          show: ['assets.manage', 'stock.manage', 'tickets.dispatch', 'energy.read', 'finance.reports'].some((p) => can(p)),
        },
        { href: '/capital-plans', label: t('nav.capital-plans'), icon: <Landmark aria-hidden />, show: can('assets.manage') },
        { href: '/compound-export', label: t('nav.compound-export'), icon: <Boxes aria-hidden />, show: can('compound.export') },
      ],
    },
    {
      label: t('group.administration'),
      items: [
        { href: '/roles', label: t('nav.roles'), icon: <ShieldCheck aria-hidden />, show: can('roles.read') },
        { href: '/settings', label: t('nav.settings'), icon: <Settings aria-hidden />, show: can('settings.manage') },
        // Who decides in my place while I am away (ADR 0073).
        { href: '/deputies', label: t('nav.deputies'), icon: <ShieldCheck aria-hidden />, show: can('deputies.manage') },
        {
          href: '/maintenance-setup',
          label: t('nav.maintenance-setup'),
          icon: <SlidersHorizontal aria-hidden />,
          show: can('maintenance.manage'),
        },
        {
          href: '/management-setup',
          label: t('nav.management-setup'),
          icon: <MessageSquareMore aria-hidden />,
          show: can('requests.manage'),
        },
        {
          href: '/community-setup',
          label: t('nav.community-setup'),
          icon: <ListChecks aria-hidden />,
          show: can('community.publish') || can('community.suggestions'),
        },
        {
          href: '/neighbours-setup',
          label: t('nav.neighbours-setup'),
          icon: <Handshake aria-hidden />,
          show: can('neighbours.manage'),
        },
        {
          href: '/deletions',
          label: t('nav.deletions'),
          icon: <UserX aria-hidden />,
          count: deletions,
          show: can('accounts.erase'),
        },
        { href: '/audit', label: t('nav.audit'), icon: <ScrollText aria-hidden />, show: can('audit.read') },
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
      <EmptyState title={c('state.noAccess')} icon={<Lock aria-hidden />}>
        <p>{t('noAccessBody')}</p>
        <Button onClick={() => void signOut()} loading={signingOut}>
          {c('shell.signOut')}
        </Button>
      </EmptyState>
    );
  } else if (redirecting) {
    body = <SkeletonRows rows={6} />;
  } else if (!isManager && pathname === '/') {
    body = (
      <EmptyState title={c('state.empty')} icon={<Wrench aria-hidden />}>
        <p>{t('noSection')}</p>
      </EmptyState>
    );
  } else {
    body = (
      <>
        {lockdownLine && pathname !== '/security/lockdowns' ? (
          <Alert tone="error">
            {lockdownLine}. <Link href="/security/lockdowns">{t('lockdownLink')}</Link>
          </Alert>
        ) : null}
        {children}
      </>
    );
  }

  return (
    <AppShell
      product={t('product')}
      context={session.data?.tenantName ?? t('compound')}
      nav={ready && allowed ? nav : []}
      user={
        me
          ? {
              name: me.fullName ?? (me.type === 'manager' ? t('role.manager') : t('role.staff')),
              meta: me.email ?? me.phone ?? '',
              href: allowed ? '/account' : undefined,
            }
          : null
      }
      onSignOut={signOut}
      crumb={pathname === '/notifications' ? t('crumb.notifications') : pathname === '/account' ? c('shell.myAccount') : undefined}
      topbarEnd={
        ready && allowed ? (
          <>
            <StaffSearch />
            <NotificationBell />
          </>
        ) : null
      }
      signingOut={signingOut}
    >
      {body}
    </AppShell>
  );
}
