import type { AccountType } from '@prisma/client';
import { DEFAULT_ROLES, LOCKOUT_PROTECTED } from './default-roles';
import {
  PERMISSIONS,
  RENAMED_PERMISSIONS,
  RETIRED_PERMISSIONS,
  type PermissionDefinition,
} from './permissions';

/**
 * Everything the access layer knows from code, as one injectable value. The
 * app uses CODE_ACCESS_CATALOG; tests inject variants to simulate a deploy
 * that adds, renames or retires permissions.
 */
export interface AccessCatalog {
  permissions: Readonly<Record<string, PermissionDefinition>>;
  defaultRoles: readonly {
    key: string;
    kind: AccountType;
    permissions: readonly string[];
  }[];
  retired: readonly string[];
  renamed: Readonly<Record<string, string>>;
  lockout: { roleKey: string; permissions: readonly string[] };
}

export const ACCESS_CATALOG = Symbol('ACCESS_CATALOG');

export const CODE_ACCESS_CATALOG: AccessCatalog = {
  permissions: PERMISSIONS,
  defaultRoles: DEFAULT_ROLES,
  retired: RETIRED_PERMISSIONS,
  renamed: RENAMED_PERMISSIONS,
  lockout: LOCKOUT_PROTECTED,
};

/** Consistency rules for a catalog; returns the problems found. */
export function catalogProblems(catalog: AccessCatalog): string[] {
  const problems: string[] = [];
  const active = new Set(Object.keys(catalog.permissions));
  for (const p of catalog.retired) {
    if (active.has(p)) problems.push(`${p} is both active and retired`);
  }
  for (const [from, to] of Object.entries(catalog.renamed)) {
    if (active.has(from))
      problems.push(`rename source ${from} is still active`);
    if (!active.has(to))
      problems.push(`rename target ${to} is not an active permission`);
    if (catalog.retired.includes(to))
      problems.push(`rename target ${to} is retired`);
  }
  const keys = new Set<string>();
  const kinds = new Set<AccountType>();
  for (const role of catalog.defaultRoles) {
    if (keys.has(role.key)) problems.push(`duplicate default role ${role.key}`);
    keys.add(role.key);
    // AccountWriter gives a new account the default role of its kind.
    if (kinds.has(role.kind))
      problems.push(`more than one default role of kind ${role.kind}`);
    kinds.add(role.kind);
    for (const p of role.permissions) {
      const def = catalog.permissions[p];
      if (!def) problems.push(`${role.key}: unknown permission ${p}`);
      else if (!def.kinds.includes(role.kind)) {
        problems.push(`${role.key}: ${p} is not assignable to ${role.kind}`);
      }
    }
  }
  const lockRole = catalog.defaultRoles.find(
    (r) => r.key === catalog.lockout.roleKey,
  );
  if (!lockRole)
    problems.push(
      `lockout role ${catalog.lockout.roleKey} is not a default role`,
    );
  for (const p of catalog.lockout.permissions) {
    if (lockRole && !lockRole.permissions.includes(p)) {
      problems.push(
        `lockout permission ${p} is not in ${catalog.lockout.roleKey} defaults`,
      );
    }
  }
  return problems;
}

/**
 * The key of the default role new accounts of `type` get, or the type itself
 * when the catalog has none (a compound may define that role on its own).
 */
export function defaultRoleKey(catalog: AccessCatalog, type: AccountType) {
  return catalog.defaultRoles.find((r) => r.kind === type)?.key ?? type;
}
