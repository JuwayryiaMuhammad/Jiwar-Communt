# 0015 — Domain folders and import boundaries

**Status:** Accepted · Phase 2

## Context
Until Phase 1b every module sat directly under `src/`. The next phases add whole domains: the resident community side (households, domestic workers, delegation), then the gate (guards, visitors, worker attendance), then more. Each needs the same foundations: tenancy, auth, permissions, audit and accounts. Without a rule, domains start importing each other's internals and the foundations start importing domain code, and nothing can change without touching everything.

## Decision
1. **`src/core/`** holds what every domain needs:
   - `config`, `common` (request context, errors, validation, locale, ids);
   - `database` (the only DB access paths);
   - `redis`;
   - `access` (permissions, roles, `ResourceAccess`);
   - `auth` (tenant login, sessions);
   - `accounts` (`AccountWriter`);
   - `audit`;
   - `platform` (super admin, compounds, `access:sync`);
   - `health`.

   Something belongs in core when a **second** domain needs it, not before.
2. **A domain is a top-level folder under `src/`** (`src/community/` now, `src/gate/` next). It owns its services, its tables' logic, and its email templates.
3. **Boundaries, enforced by ESLint** (`eslint.boundaries.cjs`, used by `eslint.config.mjs`):
   - `src/core/**` must not import any domain.
   - A domain may import `core` freely, and another domain **only through its public `index.ts`**, never its internals.
   - Folders inside one domain import each other freely.
   - `src/app.module.ts`, `main.ts`, `prisma/seed.ts` and `test/` are composition roots and may import anything.
4. **Core reaches back through hooks, never imports.** When core must trigger domain behaviour (for example: deactivating an account ends the household delegations it holds), core defines the hook and the domain registers a handler. The handler runs inside core's transaction when atomicity requires it.
5. **The rule proves itself.** `src/core/boundaries.spec.ts` lints virtual files with the same blocks:
   - core → community fails;
   - a domain → another domain's internals fails;
   - → another domain's `index.ts` passes;
   - → core passes.

   `DOMAINS` in `eslint.boundaries.cjs` must list every top-level folder under `src/` except `core`; the test fails otherwise, so a new domain is covered the moment its folder exists.

## Consequences
- `no-restricted-imports` is a single ESLint rule, so a later config block replaces an earlier one's options. The blocks are generated from shared pieces, so the base-Prisma restriction (ADR 0005) is never lost on a domain folder.
- Existing guard rails moved with the code:
  - the raw client is allowed in `src/core/database/` only;
  - `runInTenantUnsafe` in `src/core/auth/`, `src/core/platform/` and `prisma/seed.ts`, plus any single file a later ADR names;
  - the audit guard rails still scan all of `src/`, `prisma/`, `docker/` and `scripts/`, and assert that they do.
- `test/` keeps its layout; tests import from `src/core/…` and `src/community/…` directly.
- **Phase 4: the first cross-domain dependency.** `src/gate/` (ADR 0028) reads the community domain only through `src/community/index.ts`, which exports `CommunityGatePort` and its module: a narrow, transaction-taking port (units, capabilities and their holders, the household's authority, workers' engagements, schedules) instead of the community services. `DOMAINS` gained `'gate'` and nothing else changed in the lint; `boundaries.spec.ts` now lints `src/gate/` against the real blocks (core and the community index pass, deep community imports fail, core → gate fails) instead of simulating a future domain.
- Phase 4 also moved the sweep's compound walk into core: `SweepRunner.forEachTenant` is the one sweep helper allowed to call `runInTenantUnsafe`, so new tasks need no allowance of their own (ADR 0027).
