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
 * maintenance supervisor (ADR 0032).
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
      'tickets.create',
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
      'tickets.create',
    ],
  },
  {
    // Gate guards (ADR 0028): the gate only, inside a shift.
    key: 'guard',
    kindDefault: true,
    kind: 'staff',
    permissions: ['gate.operate'],
  },
  {
    // Maintenance technicians (ADR 0032): the tickets assigned to them.
    key: 'technician',
    kind: 'staff',
    kindDefault: false,
    permissions: ['tickets.work'],
  },
  {
    // Maintenance dispatch (ADR 0032): the queue and assignment. The
    // manager dispatches too, so a compound without one still works.
    key: 'maintenance_supervisor',
    kind: 'staff',
    kindDefault: false,
    permissions: ['tickets.dispatch'],
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
