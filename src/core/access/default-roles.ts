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
 * maintenance supervisor (ADR 0032), an accountant (ADR 0044).
 */
export const DEFAULT_ROLES: readonly DefaultRole[] = [
  {
    key: 'manager',
    kindDefault: true,
    kind: 'manager',
    permissions: [
      'units.read',
      'units.create',
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
    ],
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
