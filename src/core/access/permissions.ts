import type { AccountType } from '@prisma/client';

// ============================================================================
// Permission catalog (ADR 0010)
// ============================================================================
//
// The only place permissions are defined. `kinds` lists the role kinds a
// permission may ever be granted to, so e.g. `roles.manage` can never reach
// the resident role, whatever a manager does.
//
// Changing this file? Run `pnpm access:sync` (a deploy step). Removal is
// never inferred: to remove a permission, move it to `retiredPermissions`;
// to rename one, add `old: new` to `renamedPermissions`.

export interface PermissionDefinition {
  kinds: readonly AccountType[];
}

export const PERMISSIONS = {
  'units.read': { kinds: ['manager', 'resident'] },
  'units.create': { kinds: ['manager'] },
  'accounts.read': { kinds: ['manager'] },
  'accounts.manage': { kinds: ['manager'] },
  'residents.read': { kinds: ['manager'] },
  'residents.manage': { kinds: ['manager'] },
  'roles.read': { kinds: ['manager'] },
  'roles.manage': { kinds: ['manager'] },
  'audit.read': { kinds: ['manager'] },
  'settings.manage': { kinds: ['manager'] },
} as const satisfies Record<string, PermissionDefinition>;

export type Permission = keyof typeof PERMISSIONS;

/** Permissions removed on purpose; `access:sync` deletes them everywhere. */
export const RETIRED_PERMISSIONS: readonly string[] = [];

/** `old → new`; `access:sync` moves assignments as they are. */
export const RENAMED_PERMISSIONS: Readonly<Record<string, Permission>> = {};
