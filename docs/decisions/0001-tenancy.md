# 0001 — Tenancy: tenant = compound

**Status:** Accepted · Phase 0

## Context
Jiwar is sold to residential compounds. Each compound that buys the system manages its own residents, staff and units, and must never see another compound's data.

## Decision
- **One tenant = one compound (1:1).** There is no `community_id`; the compound *is* the tenant.
- Every tenant-scoped table has a `tenant_id` column, protected by Postgres row-level security (ADR 0005).
- Authorization has three layers, checked in this order:
  1. **Tenant** — enforced by RLS in the database. A query can only ever see rows of the tenant set on its transaction.
  2. **Role** — the account type (resident / staff / manager) and later finer permissions, enforced in the application.
  3. **Resource** — ownership, conflict of interest, delegation, enforced in the application.
- RLS protects the tenant layer **only**. It is a backstop against a missing `where`, not a permission system.

## Consequences
- A person who manages several compounds has one account per compound (ADR 0002).
- The journey documents describe a wider hierarchy (developer → project → phase → compound) and a management company running several compounds. That is **not** modeled in Phase 0. If developers or management companies become customers, it becomes a new layer above the tenant, and moving a compound between tenants is an explicit, audited handover (ADR 0009).
