# 0010 — Permissions and roles

**Status:** Accepted · Phase 1a

## Decision
- **Permissions are a fixed catalog in code** (`src/core/access/permissions.ts`): string keys such as `units.read`, `residents.manage`. Each permission declares which role kinds it may be granted to, so e.g. `roles.manage` can never be given to the resident role.
- **Default roles are defined in code** (`src/core/access/default-roles.ts`): `manager` and `resident` in Phase 1. `staff` stays an account type but has no role yet.
- **Roles are data per tenant.** A new compound gets its own copy of the default roles and their default permissions. A manager may edit his compound's role permissions; the change applies to every account with that role in that compound only.
- **One role per account.** `accounts.type` stays (capacity); `accounts.role_id` is added. `role.kind` must equal `account.type`, enforced by a composite foreign key `(tenant_id, role_id, type) → roles(tenant_id, id, kind)`. The composite key also makes a role from another tenant impossible: Postgres foreign-key checks bypass RLS, so a single-column key would not.
- **Permissions are not in the JWT.** `PermissionsGuard` loads the account's role and its `permissions_version` on every request and resolves permissions through Redis, keyed `perm:{tenantId}:{roleId}:{version}`. Every change bumps the version in the same transaction, so a stale value can never be read again — an edit applies on the next request, with no invalidation race.
- **Lockout protection:** the manager system role always keeps `roles.manage` and `residents.manage`.
- System roles and permissions are identified by `key` only; `roles.name` is null for them (ADR 0013).

## Permission sync (`access:sync`)
Adding a permission in code must reach existing compounds without undoing managers' edits. `tenant_permission_catalog` records which permissions each compound has already been offered. Per tenant, in one transaction:
1. **Renames** (`renamedPermissions: { old: new }` in code) move assignments and the catalog row as they are.
2. **Retirements** (`retiredPermissions` in code) are deleted from roles and the catalog.
3. **Additions:** a code permission not yet in the catalog is added to every system role whose default includes it, then recorded.
4. **Unknown leftovers** (in the DB, but in none of the lists — e.g. after a rollback) are left untouched and reported as a warning. Removal is never inferred.

A permission already in the catalog is never re-added, so a permission a manager removed stays removed. The sync is idempotent.

**Deploy order:** `prisma migrate deploy` → `access:sync` → start the server. A server started before the sync answers 403 on endpoints that need a new permission until the sync runs.

## Out of scope
Custom roles, per-account overrides (possible later as overrides on top of the role).

## Update (Phase 5.1, ADR 0032)
- Two more staff system roles, `technician` (`tickets.work`) and `maintenance_supervisor` (`tickets.dispatch`), beside `guard`. "At most one default role per kind" became **exactly one `kindDefault` per kind**: a new account gets its kind's default unless it names another role of that kind (`roleKey`), and `guard` stays the staff default. `access:sync` creates missing system roles in existing compounds.
- New permissions: `tickets.create` (resident, family), `tickets.work` (staff), `tickets.dispatch` (staff, manager; the manager has it by default) and `maintenance.manage` (manager).

## Update (Phase R1, ADR 0036)
- New permission `residents.assist` (manager kind, manager role by default): acting for a resident or family account that does not use the app.
