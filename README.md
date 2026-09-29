# Jiwar Community Backend

Backend for Jiwar, a multi-tenant platform for managing residential compounds. **One tenant = one compound.** The platform owner creates compounds and their managers; managers create residents and staff; people log in with their email or phone and a one-time code sent by email.

- **Phase 0** proved tenant isolation (Postgres row-level security + Prisma + request context) through accounts, units and the login flow.
- **Phase 1a** adds per-compound roles and permissions, the platform super admin, residents with multi-unit occupancy, and the i18n error contract.
- **Phase 1b** adds an immutable audit trail and security events.

Phases 1a and 1b add **no new HTTP endpoints**: they are designed screen by screen from the Figma design in a later phase, so the new capabilities are services tested at the service level. Architecture decisions live in [`docs/decisions/`](docs/decisions/README.md).

Stack: Node ≥ 22, pnpm, NestJS 11, Prisma 7 (`@prisma/adapter-pg`), PostgreSQL 17, Redis 7, argon2, Jest + Supertest.

## Setup

```bash
corepack enable pnpm          # once per machine
pnpm install
cp .env.example .env          # defaults work with docker-compose
docker compose up -d          # postgres :5435, redis :6381, mailpit :1025/:8025
pnpm db:migrate               # 1. migrations, as jiwar_migrator
pnpm access:sync              # 2. permission sync (see below)
pnpm seed                     # 3. demo data (idempotent)
pnpm start:dev                # http://localhost:3100/api/v1 (PORT in .env)
```

- API docs (Swagger): `/docs`, disabled when `NODE_ENV=production`.
- Emails (OTP codes): http://localhost:8025 (Mailpit).
- Ports are shifted from the usual ones so this project runs next to Jiwar-Hub-backend.

**Upgrading a Phase 0 dev database:** Phase 1a made `accounts.role_id` mandatory and Phase 0 data was never deployed, so reset instead of migrating in place: `pnpm exec prisma migrate reset --force`, then `pnpm access:sync` and `pnpm seed`. This **deletes all data** in the dev database.

## Deploy order

Same discipline as migrations:

```bash
pnpm exec prisma migrate deploy          # 1. schema
node dist/platform/access-sync.cli.js    # 2. permissions (pnpm access:sync locally)
node dist/main                           # 3. only then the server
```

A server started before step 2 answers `403` on any endpoint that requires a permission added in that release, until the sync runs.

## Database roles

`docker/postgres/init.sql` creates two roles and two databases (`jiwar`, `jiwar_test`) on first start of an empty volume:

| Role | Used by | Rights |
|---|---|---|
| `jiwar_migrator` | Prisma CLI only (`MIGRATOR_DATABASE_URL`, via `prisma.config.ts`) | Owns every table |
| `jiwar_app` | The running app, the seed and `access:sync` (`DATABASE_URL`) | SELECT/INSERT/UPDATE/DELETE only (SELECT/INSERT on the audit tables). Not an owner, not a superuser, no `BYPASSRLS` |

Every table with a `tenant_id` column has `ENABLE` + `FORCE ROW LEVEL SECURITY` with a `tenant_isolation` policy (hand-written SQL at the end of each migration, since Prisma cannot express it). A test fails if a new tenant table misses it. The only global tables that carry `tenant_id` are `login_identifiers`, `sessions` and `security_events`, and they are listed explicitly. Links between tenant tables use composite foreign keys that include `tenant_id`, because foreign-key checks bypass RLS. Changing the init script requires recreating the volume: `docker compose down -v`.

## Migrations

All migration commands run **as the migrator**. `prisma.config.ts` points the CLI at `MIGRATOR_DATABASE_URL`.

```bash
pnpm db:migrate:dev --name <change>   # create + apply in development
pnpm db:migrate                        # apply pending migrations (deploy)
```

For a new tenant-scoped table: add `tenant_id`, create the migration with `--create-only`, and append the `ENABLE`/`FORCE`/`CREATE POLICY` block before applying. `FORCE` also applies to the migrator, so a migration that changes **data** in tenant tables must `set_config('app.tenant_id', …, true)` per tenant inside its transaction (ADR 0005). A new unique index must be mapped in `src/common/db-constraints.ts`, which a test enforces, so duplicates return the right field to the client.

## Environment variables

See `.env.example` for the full list with comments. The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Runtime connection as `jiwar_app` |
| `MIGRATOR_DATABASE_URL` | Prisma CLI connection as `jiwar_migrator` |
| `TEST_DATABASE_URL`, `TEST_MIGRATOR_DATABASE_URL`, `TEST_REDIS_URL` | e2e tests (separate database, Redis db 1) |
| `TEST_SMTP_HOST`, `TEST_SMTP_PORT`, `MAILPIT_API_URL` | e2e tests always send through Mailpit and read codes from its API, whatever `SMTP_*` points at |
| `DB_POOL_MAX` | pg pool size |
| `REDIS_URL` | Rate limits, login tickets, permission cache |
| `SMTP_*` | OTP email delivery |
| `JWT_ACCESS_SECRET` | Tenant access tokens (≥ 32 chars, `aud: tenant`) |
| `PLATFORM_JWT_SECRET` | Platform tokens (≥ 32 chars, must differ from `JWT_ACCESS_SECRET`, `aud: platform`) |
| `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` | Create the first super admin on startup if none exists (password ≥ 12 chars; set both or neither). Never updates an existing admin. **In production, remove `SUPERADMIN_PASSWORD` from the environment after the first login.** |
| `PLATFORM_LOGIN_*`, `PLATFORM_LOCKOUT_SECONDS` | Super admin rate limits and lockout |
| `TRUST_PROXY` | `false` (default) or the **number** of reverse-proxy hops in front of the app. Behind one nginx on the VPS use `1` and bind the app to localhost. It decides `req.ip`, which feeds audit IPs and per-IP rate limits. Never "trust all": clients could forge `X-Forwarded-For` |
| `TEST_SUPERUSER_DATABASE_URL` | Superuser on `jiwar_test`, used **only** by `test/` to clear the immutable audit tables between runs |
| `IDENTIFIER_PEPPER` | HMAC key for login identifiers and OTP codes (≥ 32 chars). Rotating it invalidates every login identifier |
| `OTP_*` | Code TTL, max attempts, rate limits |
| `OTP_FIXED_CODE` | **Development only.** Every code becomes this value (emails are still sent). The app refuses to start with it when `NODE_ENV=production` |

The app validates the environment with zod at startup (`src/config/env.schema.ts`) and reads `process.env` only; entry points (`main.ts`, the seed, the sync CLI, the tests) load `.env` themselves.

## Tests

```bash
pnpm test         # unit + e2e (needs `docker compose up -d`)
pnpm test:unit    # src/**/*.spec.ts, no infrastructure
pnpm test:e2e     # test/**/*.e2e-spec.ts against real Postgres, Redis and Mailpit
pnpm lint
pnpm build
```

The e2e run wipes `jiwar_test`, migrates it as the migrator, runs `access:sync` like a deploy, then connects only as `jiwar_app`. The immutable audit tables are cleared over the superuser connection. `OTP_FIXED_CODE` and `SUPERADMIN_*` are removed for the run.

| Suite | Covers |
|---|---|
| `test/rls/db-isolation` | Cross-tenant reads and writes on every tenant table, fail-closed without a tenant, `WITH CHECK`, composite keys, a single-connection pool under 200 interleaved operations, `jiwar_app` unable to bypass RLS |
| `test/rls/rls-coverage` | Every table with `tenant_id` has RLS + FORCE + the policy |
| `test/rls/http-isolation` | Isolation over HTTP; field-level validation codes; duplicate values |
| `test/rls/login-bootstrap` | OTP login across tenants, identical responses, code lifecycle, sessions, email language |
| `test/access/*` | Permission guard, role edits (applied on the next request, per compound, lockout), `access:sync` (additions, renames, retirements, rollback safety) |
| `test/platform/*` | Super admin bootstrap, login, lockout, forced password change, token separation; compounds, managers, suspension |
| `test/residents/*` | Multi-unit occupancy, unit resource access, ending occupancies |
| `test/audit/*` | Audit immutability (app and owner), atomicity both ways, one scenario per catalog action and security event (and a check that none is missing), no personal data in any stored JSON, contact change, query paging |
| `test/db/unique-constraints` | Every unique index is mapped to API fields |

## Error contract (ADR 0013)

The API never returns display text. Every error has a stable `code`; the frontend translates. `message` is English, for developers only.

```json
{
  "statusCode": 400,
  "code": "VALIDATION_FAILED",
  "message": "building must be shorter than or equal to 64 characters",
  "fields": [
    { "field": "code", "code": "FIELD_REQUIRED" },
    { "field": "building", "code": "INVALID_LENGTH", "params": { "min": 1, "max": 64 } }
  ],
  "requestId": "…", "timestamp": "…", "path": "/api/v1/units"
}
```

- Top-level codes live in `src/common/errors.ts` (`UNIT_NOT_FOUND`, `ROLE_LOCKOUT`, `DUPLICATE_RESOURCE`, …), and field codes there too (`FIELD_REQUIRED`, `INVALID_PHONE`, `DUPLICATE_VALUE`, …).
- Code in `src/` throws only `AppException` (`appError.notFound(...)` etc.); a unit test fails on any other exception type.
- Database errors are mapped. A duplicate returns `DUPLICATE_RESOURCE` + the field. Anything unexpected returns `INTERNAL_ERROR` without database text.
- The OTP email is Arabic (RTL) or English, chosen from `Accept-Language` (default Arabic). Accounts and admins carry `preferred_locale`.

## Access control

Four layers, each enforced in exactly one place:

1. **Tenant:** Postgres RLS (ADR 0005).
2. **Account and compound status:** checked on **every request** by `PermissionsGuard`. A deactivated account or suspended compound is rejected immediately, not when the 15-minute token expires.
3. **Permissions (ADR 0010):**
   - The catalog and default roles are defined in code (`src/access/permissions.ts`, `default-roles.ts`).
   - Each compound has its own copy of the `manager` and `resident` roles; a manager can edit his compound's role permissions (`RolesService`).
   - Routes declare `@RequirePermissions('units.read')`. Permissions are not in the JWT; they are cached in Redis under `perm:{tenant}:{role}:{version}`, and every edit bumps the version, so changes apply on the next request.
   - The manager role can never lose `roles.manage` / `residents.manage`.
   - To remove or rename a permission, list it in `RETIRED_PERMISSIONS` / `RENAMED_PERMISSIONS`; `access:sync` never infers removal.
4. **Resource (ADR 0012):** `ResourceAccess` limits a resident to units he actively occupies. A miss is `UNIT_NOT_FOUND`, never `FORBIDDEN`.

## Audit trail (ADR 0014)

Three append-only tables:

| Table | Scope | Written |
|---|---|---|
| `audit_log` | Compound (RLS) | In the transaction of the action (fail-closed) |
| `platform_audit_log` | Global | In the transaction of the platform action |
| `security_events` | Global | On its own, fail-open (a logging failure never blocks a login) |

- **Immutable:** `jiwar_app` has only `SELECT, INSERT`, and triggers reject `UPDATE`/`DELETE`/`TRUNCATE` for every role, the owner included. The owner can still `DISABLE TRIGGER` with DDL; this is a documented limit, and hash chaining is the deferred fix.
- **Catalog** (`src/audit/actions.ts`): every audited action and security event is declared there with its target type. A unit test fails if one is never emitted, and the coverage suite fails if one has no scenario.
- **Recording:**
  - `AuditService.record(tx, { action, targetId, changes, metadata })` requires the action's transaction.
  - The compound is taken from that transaction; the actor (account / platform admin / system) and the IP, user agent and request id come from the request context.
  - `diffChanges(before, after, action)` records only changed fields.
- **No personal data by value:**
  - Names, national IDs, phones, emails and secrets are stored as `{ changed: true }`; screens show names by joining `actor_id`/`target_id` to `accounts`.
  - A sensitive key in `metadata` throws.
  - A value that merely looks personal is replaced by `"[redacted]"` with a warning; tests throw instead.
- **Security events** store only the identifier HMAC, never an email or phone.
- **Reading:** `AuditQueryService` (current compound, permission `audit.read`), `PlatformAuditQueryService` and `SecurityEventsQueryService` page with opaque `(occurred_at, id)` cursors. Endpoints come with the design.
- **Changing a login phone/email** (`ResidentsService.updateContact`) re-keys the login lookup and invalidates every pending OTP code for that account in the same transaction, so a code already sent to the old address stops working.

## Platform super admin (ADR 0011)

The platform owner is not a tenant account. It manages compounds and their managers (`TenantsService`: create, list, suspend/reactivate, add/deactivate managers) and **cannot read data inside a compound**.

- It logs in with email + password (argon2id); every failure returns the same error, with rate limits and a lockout.
- The first login forces a password change. The restricted token issued for that is accepted only by routes marked `@PlatformAuth({ allowPasswordChange: true })`.
- Platform and tenant tokens use different secrets and audiences, and each guard rejects the other's tokens.
- Endpoints come in a later phase; the services and `PlatformAuthGuard` are ready.

## Login flow (tenant accounts)

```
POST /api/v1/auth/otp/request    { identifier }              → 202 { code: "OTP_REQUESTED" } — same body whether or not it exists
POST /api/v1/auth/otp/verify     { identifier, code }        → { loginTicket, accounts: [{ accountId, tenantName, accountType }] }
POST /api/v1/auth/select-account { loginTicket, accountId }  → { accessToken (15 min), refreshToken, … }
POST /api/v1/auth/refresh        { refreshToken }            → new pair (rotation; replaying an old token revokes the session)
POST /api/v1/auth/logout         { refreshToken }            → 204
```

1. The identifier is an email or a phone (local Egyptian `010…` or international `+…`). It is normalized and looked up by HMAC in the global `login_identifiers` table, which holds no personal data.
2. A 6-digit code is emailed to each matching account's email, in the language from `Accept-Language`. When a phone matches accounts with different emails, each email gets its own code, which unlocks only the accounts behind it. A new request invalidates older codes; each code allows 5 attempts and lasts 5 minutes.
3. When several accounts match, the user picks one. The access token carries `sub`, `tid`, `typ` and `aud: tenant`; everything else is read from the database per request.
4. Accounts that are inactive, or that belong to a suspended compound, get the same generic failures at every step.

**Try it after `pnpm seed`**, with `OTP_FIXED_CODE=123456` in `.env`:
- Request a code for `01000000003` (a resident in both demo compounds) and verify with `123456`: you get two accounts.
- Or use `resident.a@jiwar.local`, who owns A-101 and rents A-102: `GET /api/v1/units` shows exactly those two units.

## Project layout

```
src/
  config/      zod env schema
  common/      request context (CLS), guards, error filter + codes, validation mapping, locale, uuid
  database/    PrismaService.tenant, TenantTx, GlobalDbService — the only DB access paths
  access/      permission catalog, default roles, PermissionsGuard, RolesService, ResourceAccess
  auth/        tenant login: identifiers, OTP (+ email templates), sessions
  accounts/    manager-created accounts; AccountWriter (the one place accounts are written)
  units/       units, scoped by ResourceAccess
  residents/   residents and unit occupancies
  platform/    super admin auth + guard + bootstrap, compounds (TenantsService), access:sync
  audit/       audit catalog, diff + personal-data guard, audit/platform/security services, query services
  redis/       Redis client, rate limiter
  health/      readiness (db, redis, tenant-setting leak canary)
prisma/        schema, migrations (RLS SQL inside), seed
docker/        postgres init (roles)
test/          rls/, access/, platform/, residents/, audit/, db/ suites + setup/
docs/decisions ADRs
```

Rules the code enforces:
- **Tenant data** goes through `prisma.tenant.<model>` (single queries) or `withTenantTx` (multi-statement work and raw SQL). The raw Prisma client cannot be imported outside `src/database/` (ESLint).
- **`runInTenantUnsafe`** takes the tenant from the caller, not the request. It is allowed only in `src/auth/`, `src/platform/` and `prisma/seed.ts` (ESLint).
- **`tenantId` comes from the token only.** It never appears in a request DTO, and unknown body fields are rejected.
- **Errors** are thrown only as `AppException`, with a code (unit test).
- **Audit entries** are written only through `AuditService` / `PlatformAuditService`, with the action's transaction. Bypassing the immutability triggers (`session_replication_role`) is allowed only in `test/` (unit test).
