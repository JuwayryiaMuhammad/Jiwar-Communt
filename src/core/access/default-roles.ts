import type { AccountType } from '@prisma/client';
import type { Permission } from './permissions';

export interface DefaultRole {
  /** Also the account type it serves; system roles are found by key. */
  key: string;
  kind: AccountType;
  permissions: readonly Permission[];
}

/**
 * Copied into every new compound (ADR 0010), at most one per kind: a new
 * account gets the default role of its kind. A staff account may name
 * another staff-kind role of its compound instead (`roleKey`), so a second
 * staff role (a technician) does not change how accounts are created.
 */
export const DEFAULT_ROLES: readonly DefaultRole[] = [
  {
    key: 'manager',
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
    ],
  },
  {
    key: 'resident',
    kind: 'resident',
    permissions: [
      'units.read',
      'household.manage',
      'household.delegate',
      'workers.manage',
      'visitors.invite',
    ],
  },
  {
    // Household members with a login (ADR 0016).
    key: 'family_member',
    kind: 'family',
    permissions: [
      'units.read',
      'household.manage',
      'workers.manage',
      'visitors.invite',
    ],
  },
  {
    // Gate guards (ADR 0028): the gate only, inside a shift.
    key: 'guard',
    kind: 'staff',
    permissions: ['gate.operate'],
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
