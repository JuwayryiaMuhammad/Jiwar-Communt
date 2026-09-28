import type { AccountType } from '@prisma/client';
import type { Permission } from './permissions';

export interface DefaultRole {
  /** Also the account type it serves; system roles are found by key. */
  key: string;
  kind: AccountType;
  permissions: readonly Permission[];
}

/**
 * Copied into every new compound (ADR 0010). `staff` has no role yet, so
 * staff accounts cannot be created until one is defined here.
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
      'residents.read',
      'residents.manage',
      'roles.read',
      'roles.manage',
    ],
  },
  {
    key: 'resident',
    kind: 'resident',
    permissions: ['units.read'],
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
