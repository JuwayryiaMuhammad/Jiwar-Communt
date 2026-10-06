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
  'units.read': { kinds: ['manager', 'resident', 'family'] },
  'units.create': { kinds: ['manager'] },
  'accounts.read': { kinds: ['manager'] },
  'accounts.manage': { kinds: ['manager'] },
  // Account deletion (ADR 0023): the three-step erasure, and legal holds.
  'accounts.erase': { kinds: ['manager'] },
  'accounts.legal_hold': { kinds: ['manager'] },
  'residents.read': { kinds: ['manager'] },
  'residents.manage': { kinds: ['manager'] },
  // Acting for an account that does not use the app (ADR 0036): its
  // delivery preferences, consents, an export or a deletion request, each
  // with a reason code, marked assisted, the account told.
  'residents.assist': { kinds: ['manager'] },
  'roles.read': { kinds: ['manager'] },
  'roles.manage': { kinds: ['manager'] },
  'audit.read': { kinds: ['manager'] },
  'settings.manage': { kinds: ['manager'] },
  // Household (ADR 0016). The service still requires the unit's primary
  // resident (or a delegate) on top of the permission.
  'household.manage': { kinds: ['resident', 'family'] },
  'household.approve': { kinds: ['manager'] },
  // Manager decisions on a household: removal during a separation (ADR 0021).
  'household.override': { kinds: ['manager'] },
  // Only the primary resident delegates (checked by the service).
  'household.delegate': { kinds: ['resident'] },
  // Domestic workers (ADR 0017). The service still requires an occupant of
  // the unit (or a `workers` delegate) on top of `workers.manage`.
  'workers.manage': { kinds: ['resident', 'family'] },
  'workers.review': { kinds: ['manager'] },
  'workers.ban': { kinds: ['manager'] },
  // The compliance officer (ADR 0022): underage reports and their cases.
  'workers.compliance': { kinds: ['manager'] },
  // Lost and confiscated cards: management now, security with the gate.
  'workers.incidents': { kinds: ['manager'] },
  // The gate (ADR 0028). Guards operate it inside a shift; managers set up
  // the gates and read the entries; occupants and members invite visitors
  // (capabilities.visitorsInvite decides per unit).
  'gate.operate': { kinds: ['staff'] },
  'gate.manage': { kinds: ['manager'] },
  'gate.read': { kinds: ['manager'] },
  'visitors.invite': { kinds: ['resident', 'family'] },
  // One's own photo, shown to the guard at the gate (ADR 0031).
  'profile.photo': { kinds: ['resident', 'family'] },
  // Maintenance (ADR 0032). Residents and family open tickets
  // (capabilities.tickets decides per unit); technicians work the ones
  // assigned to them; dispatchers (a supervisor, or the manager) assign
  // them and see every ticket; the manager sets categories and settings.
  'tickets.create': { kinds: ['resident', 'family'] },
  'tickets.work': { kinds: ['staff'] },
  'tickets.dispatch': { kinds: ['staff', 'manager'] },
  'maintenance.manage': { kinds: ['manager'] },
  // Parcels (ADR 0035). Guards receive and hand over inside a shift; the
  // manager reads every parcel (no names) and sets the holding periods.
  // Residents act through the capability `parcels`, with no permission.
  'parcels.handle': { kinds: ['staff'] },
  'parcels.manage': { kinds: ['manager'] },
} as const satisfies Record<string, PermissionDefinition>;

export type Permission = keyof typeof PERMISSIONS;

/** Permissions removed on purpose; `access:sync` deletes them everywhere. */
export const RETIRED_PERMISSIONS: readonly string[] = [];

/** `old → new`; `access:sync` moves assignments as they are. */
export const RENAMED_PERMISSIONS: Readonly<Record<string, Permission>> = {};
