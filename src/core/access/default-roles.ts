import type { AccountType } from '@prisma/client';
import type { Permission } from './permissions';

export interface DefaultRole {
  /** System roles are found by key. */
  key: string;
  kind: AccountType;
  /**
   * The role a new account of this kind gets when it names none: exactly
   * one per kind (ADR 0010, 0032).
   */
  kindDefault: boolean;
  permissions: readonly Permission[];
}

/**
 * Copied into every new compound (ADR 0010). A new account gets the
 * `kindDefault` role of its kind; a staff account may name another
 * staff-kind role of its compound instead (`roleKey`): a technician or a
 * maintenance supervisor (ADR 0032), an accountant (ADR 0044), a collector
 * (ADR 0069).
 */
export const DEFAULT_ROLES: readonly DefaultRole[] = [
  {
    key: 'manager',
    kindDefault: true,
    kind: 'manager',
    permissions: [
      'units.read',
      'units.create',
      'units.manage',
      'accounts.read',
      'accounts.manage',
      'accounts.erase',
      'accounts.legal_hold',
      'residents.read',
      'residents.manage',
      'unit_documents.manage',
      'content.manage',
      'contracts.manage',
      'deposits.manage',
      'residents.assist',
      'roles.read',
      'roles.manage',
      'audit.read',
      'settings.manage',
      'household.approve',
      'household.override',
      'workers.review',
      'workers.ban',
      'workers.compliance',
      'workers.incidents',
      'gate.manage',
      'gate.read',
      'tickets.dispatch',
      // ADR 0081.
      'tickets.sensitive',
      'maintenance.manage',
      'assets.read',
      'assets.manage',
      'inspections.manage',
      'stock.manage',
      'energy.read',
      'energy.manage',
      'readiness.manage',
      'safety.manage',
      'parcels.manage',
      'requests.handle',
      'requests.manage',
      'community.publish',
      'community.suggestions',
      'neighbours.handle',
      'neighbours.manage',
      'facilities.manage',
      'bookings.handle',
      'club.billing',
      'vehicles.manage',
      'fines.issue',
      'fines.billing',
      'parking_reports.handle',
      'finance.gateway',
      'finance.billing',
      'finance.invoice',
      'finance.payments',
      'emergencies.manage',
      'gate_services.handle',
      'finance.refund',
      'finance.reports',
      'permits.manage',
      'guard_roster.manage',
      'guard_tasks.manage',
      'guard_instructions.manage',
      'guard_reports.read',
      'found_items.manage',
      'governance.manage',
      'governance.approvals',
      'finance.budget',
      // ADR 0085.
      'finance.treasury',
      'finance.custody',
      // ADR 0091.
      'finance.cashflow',
      // ADR 0092.
      'finance.ledger',
      'finance.ledger_write',
      'finance.ledger_reopen',
      'patrols.manage',
      'incidents.manage',
      'blocklist.manage',
      'violations.manage',
      'violations.issue',
      'lockdown.end',
      'gate_exceptions.decide',
      'gate_log.search',
      'gate_devices.manage',
      'partners.manage',
      'appeals.decide',
      'market.handle',
      'inbox.read',
      'deputies.manage',
      'vendors.manage',
      'purchases.request',
      'purchases.approve',
      'dashboard.read',
      // ADR 0084.
      'spaces.manage',
      'letters.issue',
      'correspondence.read',
      // Compliance and safety (ADR 0087).
      'compliance.manage',
      'lockdown.start',
      'experience.manage',
      'experience.compensate',
      'field_team.manage',
      'finance.payables',
      'finance.payables_approve',
      // Purchase orders, what arrived against them, and a mismatch let
      // through (ADR 0094).
      'purchase_orders.raise',
      'purchase_orders.receive',
      'finance.match_override',
      // Tenders (ADR 0088); a second holder of tenders.open confirms an
      // opening, the accountant by default.
      'tenders.manage',
      'tenders.open',
      'reports.schedule',
      'compound.export',
    ],
  },
  {
    key: 'resident',
    kindDefault: true,
    kind: 'resident',
    permissions: [
      'units.read',
      'household.manage',
      'household.delegate',
      'workers.manage',
      'visitors.invite',
      'profile.photo',
      'profile.contact',
      'tickets.create',
      'requests.create',
      'community.read',
      'suggestions.create',
      'neighbours.complain',
      'neighbours.board',
      'facilities.book',
      'vehicles.register',
      'parking.report',
      'emergencies.report',
      'gate_services.request',
      'permits.request',
      'governance.read',
      'partners.request',
      'market.post',
    ],
  },
  {
    // Household members with a login (ADR 0016).
    key: 'family_member',
    kindDefault: true,
    kind: 'family',
    permissions: [
      'units.read',
      'household.manage',
      'workers.manage',
      'visitors.invite',
      'profile.photo',
      'profile.contact',
      'tickets.create',
      'requests.create',
      'community.read',
      'suggestions.create',
      'neighbours.complain',
      'neighbours.board',
      'facilities.book',
      'vehicles.register',
      'parking.report',
      'emergencies.report',
      'gate_services.request',
      'permits.request',
      'partners.request',
      'market.post',
    ],
  },
  {
    // Gate guards (ADR 0028): the gate and its parcels (ADR 0035), inside a
    // shift, and the wrong-parking reports to close (ADR 0050; turning one
    // into a fine stays `fines.issue`). Existing compounds' guard roles got
    // `parking_reports.handle` from migration 20261028090000.
    key: 'guard',
    kindDefault: true,
    kind: 'staff',
    permissions: ['gate.operate', 'parcels.handle', 'parking_reports.handle'],
  },
  {
    // The security supervisor (ADR 0050): the guards' roster and swaps,
    // their tasks and instructions, the daily report, the patrols (ADR
    // 0052), and the incidents, the blocklist and the violations' appeals
    // (ADR 0053), and the units' list to find one by its code. Not a guard:
    // a compound adds `gate.operate` to work a gate too.
    key: 'security_supervisor',
    kind: 'staff',
    kindDefault: false,
    permissions: [
      'guard_roster.manage',
      'guard_tasks.manage',
      'guard_instructions.manage',
      'guard_reports.read',
      'patrols.manage',
      'incidents.manage',
      'blocklist.manage',
      'violations.manage',
      'gate_devices.manage',
      'units.directory',
      // The control room's channel (ADR 0068).
      'control_room.watch',
      'inbox.read',
      // What the guards need bought (ADR 0077).
      'purchases.request',
      'dashboard.read',
    ],
  },
  {
    // Maintenance technicians (ADR 0032): the tickets assigned to them;
    // the asset register in the field and their inspections (ADR 0064);
    // the meters they read (ADR 0066).
    key: 'technician',
    kind: 'staff',
    kindDefault: false,
    permissions: [
      'tickets.work',
      'assets.read',
      'inspections.perform',
      'meters.record',
      // A part or a service the store lacks (ADR 0077).
      'purchases.request',
    ],
  },
  {
    // Maintenance dispatch (ADR 0032): the queue and assignment. The
    // manager dispatches too, so a compound without one still works. The
    // asset register, the plans and the inspection rounds (ADR 0064); the
    // maintenance store (ADR 0065); the meters, consumption and utility
    // outages (ADR 0066); readiness and field safety (ADR 0067).
    key: 'maintenance_supervisor',
    kind: 'staff',
    kindDefault: false,
    permissions: [
      'tickets.dispatch',
      'assets.read',
      'assets.manage',
      'inspections.manage',
      'stock.manage',
      'energy.read',
      'energy.manage',
      'meters.record',
      'readiness.manage',
      'safety.manage',
      'inbox.read',
      'purchases.request',
      'dashboard.read',
      'field_team.manage',
      // The store raises the orders it receives against (ADR 0094).
      'purchase_orders.raise',
      'purchase_orders.receive',
    ],
  },
  {
    // The accountant (ADR 0044, 0045, 0046, 0048, 0055): the club's
    // memberships and the offline payments that keep them, the vehicle
    // fines' payments at the office, the units' billing plans, invoices,
    // credit notes and payments, the finance reports, and the decision
    // packages it puts to the board, the budget and the expenses. Never the
    // gateway's credentials,
    // never a refund, and nothing else of the compound.
    key: 'accountant',
    kind: 'staff',
    kindDefault: false,
    permissions: [
      'club.billing',
      'fines.billing',
      'finance.billing',
      'finance.invoice',
      'finance.payments',
      'finance.reports',
      'governance.approvals',
      'finance.budget',
      'inbox.read',
      'purchases.request',
      'dashboard.read',
      // Records vendors' invoices and pays out what the manager approved
      // (ADR 0089).
      'finance.payables',
      // The second person at a tender's opening (ADR 0088).
      'tenders.open',
      // ADR 0085: the bank and cash accounts, never a custody variance.
      'finance.treasury',
      // ADR 0091: the cash flow forecast and liquidity.
      'finance.cashflow',
      // ADR 0092: the general ledger and its manual entries; never a reopen.
      'finance.ledger',
      'finance.ledger_write',
      // ADR 0094: raises purchase orders; never receives what arrives, and
      // never lets a mismatch past.
      'purchase_orders.raise',
    ],
  },
  {
    // The field collector (ADR 0069): the collector visits assigned to them,
    // cash taken on a visit or why it failed. Nothing else of the compound:
    // no balance, no phone, no invoice.
    key: 'collector',
    kind: 'staff',
    kindDefault: false,
    permissions: ['finance.collect'],
  },
  {
    // A unit proxy (ADR 0063): an outside person an owner trusts with a
    // closed or vacant unit. The role is the most a proxy holds; what each
    // may do on its unit is its scopes, and nothing while the unit is open
    // with a primary (the capabilities decide).
    key: 'unit_proxy',
    kindDefault: true,
    kind: 'proxy',
    permissions: [
      'units.read',
      'community.read',
      'visitors.invite',
      'tickets.create',
      'requests.create',
      'permits.request',
    ],
  },
  {
    // A vendor's contractor (ADR 0088): the tickets dispatched to its
    // vendor that it took, through the technician's routes; the tenders
    // its vendor is invited to; its vendor's invoices. Nothing else of the
    // compound: no unit, no resident beyond what its ticket shows.
    key: 'contractor',
    kindDefault: true,
    kind: 'contractor',
    permissions: [
      'tickets.contract_work',
      'tenders.bid',
      'vendor_invoices.submit',
      // Its company's purchase orders, acknowledged (ADR 0094).
      'purchase_orders.acknowledge',
    ],
  },
];

/**
 * The manager system role can never lose these: without them no one in the
 * compound could repair its roles or its residents (lockout protection).
 */
export const LOCKOUT_PROTECTED: {
  roleKey: string;
  permissions: readonly Permission[];
} = {
  roleKey: 'manager',
  permissions: ['roles.manage', 'residents.manage'],
};
