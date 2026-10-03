# Jiwar Community Backend

[![CI](https://github.com/JuwayryiaMuhammad/Jiwar-Communt/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JuwayryiaMuhammad/Jiwar-Communt/actions/workflows/ci.yml)

Backend for Jiwar, a multi-tenant platform for managing residential compounds. **One tenant = one compound.** The platform owner creates compounds and their managers; managers create residents and staff; people log in with their email or phone and a one-time code sent by email.

- **Phase 0** proved tenant isolation (Postgres row-level security + Prisma + request context) through accounts, units and the login flow.
- **Phase 1a** adds per-compound roles and permissions, the platform super admin, residents with multi-unit occupancy, and the i18n error contract.
- **Phase 1b** adds an immutable audit trail and security events.
- **Phase 2** splits the code into `core` and the `community` domain, and adds:
  - the primary resident of each unit;
  - households: family members by invite, and minors without an account;
  - delegation from the primary to an adult member;
  - resident self-service (language, sessions);
  - domestic workers (registration, review, access codes, suspension, ban).
- **Phase 2.1** adds:
  - identity documents: a national ID or a passport, with a stored birth date and a manager's attestation for passport workers;
  - overnight worker schedules, and a time zone per compound;
  - a separate rejection email;
  - a transactional email outbox;
  - the managers' list of units needing a household review.

- **Phase 2.2** adds occupancy capacities and capabilities, unit states and member permissions, worker compliance, frozen accounts and erasure, and self-registration.
- **Phase 3** exposes all of it over HTTP as **API v0, a draft** (below).
- **Phase 4** adds CI (ADR 0026), the in-app notifications inbox (ADR 0027), idempotent writes, and the **gate** domain (ADR 0028): guards and shifts, visitor passes, verify and the append-only gate log, approvals with standing instructions, and workers at the gate with their attendance.

Phases 1a to 2.2 were services tested at the service level; Phase 3 puts thin controllers in front of them. Architecture decisions live in [`docs/decisions/`](docs/decisions/README.md).

## API v0 is a draft

Every endpoint exists so the features can be exercised end to end now. When the Figma design is ready, endpoints are reshaped screen by screen; until then:

- every operation carries `x-stability: draft` in Swagger, and **nothing is frozen**: paths, fields and shapes may change without a version bump;
- the contract is [`docs/api/openapi.v0.json`](docs/api/openapi.v0.json), written by `pnpm openapi:export`; a test fails when it is stale, so every API change shows up in review as a diff of that file;
- endpoints whose shape clearly depends on a screen are built minimal and listed in [`docs/api/v0-notes.md`](docs/api/v0-notes.md) under "to reshape with design".

Conventions (ADR 0025):

- `/api/v1`, resource-oriented. Actions are `POST /resource/:id/<verb>`; no `DELETE` with a body.
- Tenant routes use the tenant guards and `@RequirePermissions` (or `@RequireAnyPermission`); platform routes live under `/platform` with `@PlatformAuth`; public routes are `@Public` and rate-limited. Controllers only validate, call one service method and map the result through a view in `<module>/views/`.
- Lists: `?cursor=&limit=` (1–100, default 20) → `{ data, nextCursor }`. Every cursor is the same opaque `(timestamp, id)` keyset. Bounded collections (a unit's household, my sessions, the roles…) have the same shape with `nextCursor: null`.
- Reasons: `{ reasonCode, reason }`; the service answers `REASON_REQUIRED` or `INVALID_REASON_CODE` (with `allowed`).
- Personal data: document numbers never in lists and masked (`••••1234`) in details; birth dates never in lists; residents and family never see other people's contact details or documents; an erased account is `{ id, erased: true }`; free-text reasons and notes are never returned in lists.
- Secrets shown once (access codes, invite and link tokens, session tokens) come with `Cache-Control: no-store` and are never logged.
- **`GET /me/units/:unitId/capabilities` is what the apps use to show or hide features**: the `capabilitiesFor` record (ADR 0020) for the caller on that unit. Endpoints enforce the same rules; a test keeps the two consistent.

Stack: Node ≥ 22, pnpm, NestJS 11, Prisma 7 (`@prisma/adapter-pg`), PostgreSQL 17, Redis 7, argon2, Jest + Supertest.

## Run everything in Docker

The repo is a pnpm workspace: the backend at the root, the two dashboards in `apps/`, their shared code in `packages/` (see [apps/README.md](apps/README.md)).

```bash
cp .env.example .env          # once; the containers read it after .env.example
docker compose up -d --build  # infrastructure, migrations + access:sync, API, both dashboards
```

| Service | URL |
|---|---|
| API | http://localhost:3100/api/v1 (Swagger on `/docs`) |
| Super admin dashboard | http://localhost:3001 |
| Manager dashboard | http://localhost:3002 |
| Mailpit (emails, OTP codes) | http://localhost:8025 |
| MinIO console | http://localhost:9006 |

The API container uses the same `jiwar` database and the secrets in your `.env`, so it and an API run on the host see the same accounts. Every email from the containers goes to Mailpit. `docker compose up -d --build` again after code changes; `docker compose logs -f api` to follow the API.

## Setup (API on the host)

```bash
corepack enable pnpm          # once per machine
pnpm install
cp .env.example .env          # defaults work with docker-compose
docker compose up -d postgres redis mailpit minio   # infrastructure only: postgres :5435, redis :6381, mailpit :1025/:8025, minio :9005/:9006
pnpm storage:init             # once: the dev bucket on MinIO
pnpm db:migrate               # 1. migrations, as jiwar_migrator
pnpm access:sync              # 2. permission sync (see below)
pnpm seed                     # 3. demo data (idempotent)
pnpm start:dev                # http://localhost:3100/api/v1 (PORT in .env)
```

- API docs (Swagger): `/docs`, disabled when `NODE_ENV=production`.
- With the full Docker stack also running, the `api` container already holds port 3100: stop it (`docker compose stop api`) or give the host API another `PORT`.
- Emails (OTP codes): http://localhost:8025 (Mailpit).
- Ports are shifted from the usual ones so this project runs next to Jiwar-Hub-backend.

**Upgrading a Phase 0 dev database:** Phase 1a made `accounts.role_id` mandatory and Phase 0 data was never deployed, so reset instead of migrating in place: `pnpm exec prisma migrate reset --force`, then `pnpm access:sync` and `pnpm seed`. This **deletes all data** in the dev database.

## Deploy order

Same discipline as migrations:

```bash
pnpm exec prisma migrate deploy          # 1. schema
node dist/core/platform/access-sync.cli.js  # 2. permissions and missing default roles (pnpm access:sync locally)
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

For a new tenant-scoped table: add `tenant_id`, create the migration with `--create-only`, and append the `ENABLE`/`FORCE`/`CREATE POLICY` block before applying. `FORCE` also applies to the migrator, so a migration that changes **data** in tenant tables must `set_config('app.tenant_id', …, true)` per tenant inside its transaction (ADR 0005). A new unique index must be mapped in `src/core/common/db-constraints.ts`, which a test enforces, so duplicates return the right field to the client.

## Environment variables

See `.env.example` for the full list with comments. The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Runtime connection as `jiwar_app` |
| `MIGRATOR_DATABASE_URL` | Prisma CLI connection as `jiwar_migrator` |
| `TEST_DATABASE_URL`, `TEST_MIGRATOR_DATABASE_URL`, `TEST_REDIS_URL` | e2e tests (separate database, Redis db 1) |
| `TEST_SMTP_HOST`, `TEST_SMTP_PORT`, `MAILPIT_API_URL` | e2e tests always send through Mailpit and read codes from its API, whatever `SMTP_*` points at |
| `DB_POOL_MAX` | pg pool size |
| `OUTBOX_ENABLED`, `OUTBOX_POLL_MS`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_RETENTION_DAYS` | Email outbox (ADR 0019): the in-app poller (default on, every 5 s), attempts before a message is dead (8), and days before sent rows are deleted and dead rows stripped of recipient and params (30). Tests turn the poller off and drain explicitly |
| `SWEEP_ENABLED`, `SWEEP_INTERVAL_MS` | The in-app sweep (ADR 0021): majority notices, registration expiry, overdue erasures. Default on, hourly. Every task is idempotent and safe on several instances; tests turn it off and call `SweepRunner.run(name, now)` |
| `REGISTRATION_PENDING_DAYS` | A self-registration nobody decided expires and loses its personal data (default 30, ADR 0024) |
| `DELETION_GRACE_DAYS`, `ERASURE_OVERDUE_DAYS` | Account deletion (ADR 0023): the holder can undo for 30 days; the erasure holders are told once when a request waits 7 days past that |
| `GATE_UNCONFIRMED_EXIT_HOURS`, `GATE_VERIFY_RATE_LIMIT_PER_MINUTE` | The gate (ADR 0028): someone recorded inside this long gets a system exit marked unconfirmed (default 12; live-in workers excepted); code checks per guard per minute (default 30) |
| `NOTIFICATIONS_RETENTION_DAYS` | Read in-app notifications are deleted after this (default 90, ADR 0027); unread ones stay |
| `SECURITY_EVENT_TIMEOUT_MS` | Database-side cap on each security event insert (default 500). A locked `security_events` table delays a login by at most this much; the event is dropped with an error log |
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

The app validates the environment with zod at startup (`src/core/config/env.schema.ts`) and reads `process.env` only; entry points (`main.ts`, the seed, the sync CLI, the tests) load `.env` themselves.

## Tests

```bash
pnpm test         # unit + e2e (needs the infrastructure: `docker compose up -d postgres redis mailpit minio`)
pnpm test:unit    # src/**/*.spec.ts, no infrastructure
pnpm test:e2e     # test/**/*.e2e-spec.ts against real Postgres, Redis and Mailpit
pnpm lint
pnpm build
pnpm openapi:export  # after any API change; the docs suite checks the file
```

### Reproduce CI locally

CI (`.github/workflows/ci.yml`, ADR 0026) runs on every pull request and push to `main`, against the same images, with `.env.example` as its `.env` and no secrets. The same steps on a fresh stack:

```bash
docker compose down -v && docker compose up -d postgres redis mailpit minio   # fresh volume: init.sql runs
cp .env.example .env                             # only on a scratch checkout: never over your own .env
pnpm install --frozen-lockfile
pnpm db:migrate && pnpm access:sync
pnpm lint:check                                  # ESLint without --fix
pnpm build && pnpm test:unit && pnpm test:e2e
pnpm openapi:export && git diff --exit-code docs/api/openapi.v0.json
```

The e2e run wipes `jiwar_test`, migrates it as the migrator, runs `access:sync` like a deploy, then connects only as `jiwar_app`. The immutable audit tables are cleared over the superuser connection. `OTP_FIXED_CODE` and `SUPERADMIN_*` are removed for the run. Files go to the local MinIO's `TEST_S3_BUCKET`, created and emptied on start, whatever `S3_*` points at. The R2 smoke test (`R2_SMOKE=1 pnpm test:r2-smoke`, skipped otherwise) is the one run that uses the bucket in `S3_*` (ADR 0029, deploy/README.md).

| Suite | Covers |
|---|---|
| `test/rls/db-isolation` | Cross-tenant reads and writes on every tenant table, fail-closed without a tenant, `WITH CHECK`, composite keys, a single-connection pool under 200 interleaved operations, `jiwar_app` unable to bypass RLS |
| `test/rls/rls-coverage` | Every table with `tenant_id` has RLS + FORCE + the policy |
| `test/rls/http-isolation` | Isolation over HTTP; field-level validation codes; duplicate values |
| `test/rls/login-bootstrap` | OTP login across tenants, identical responses, code lifecycle, sessions, email language |
| `test/access/*` | Permission guard, role edits (applied on the next request, per compound, lockout), `access:sync` (additions, renames, retirements, rollback safety) |
| `test/platform/*` | Super admin bootstrap, login, lockout, forced password change, token separation; compounds, managers, suspension |
| `test/residents/*` | Multi-unit occupancy, unit resource access, ending occupancies |
| `test/audit/*` | Audit immutability (app and owner), atomicity both ways, one scenario per catalog action and security event (and a check that none is missing), no personal data in any stored JSON, contact change, query paging, security events fail-open and bounded under a real table lock |
| `test/db/unique-constraints` | Every unique index is mapped to API fields |
| `test/rls/community-isolation` | Every Phase 2 tenant table isolated; every household/worker constraint asserted by name; no DELETE for the app |
| `test/auth/*` | OTP purposes never interchangeable; session origin; `sid` — revocation cuts the access token at once |
| `test/settings/*` | Tenant settings: defaults, per compound, validation, audit |
| `test/db/identity-and-outbox-schema` | The SQL birth-date backfill against the code parser (the migration's own block), and every Phase 2.1 constraint by name |
| `test/mail/outbox` | Enqueue rolls back with the action (both ways), backoff with SMTP down, dead after the last attempt, two processors never sending the same message, expired leases, retention, flows queueing instead of sending, OTP still direct, the poller starting and stopping |
| `test/community/*` | National ID and passports (accounts, household, workers with attestation); primary resident (incl. concurrency); households; delegation; self-service; domestic workers; one audit scenario per Phase 2 action plus a secrets scan |
| `test/community/*` (Phase 2.2) | Capacities and capabilities; death, separation, change of primary, end of household, transfer; member permissions and the finance cap (incl. the DB refusing finance to a minor); deferred actions; minors reaching 18 across time zones; compliance cases and wage obligations; card incidents; self-registration incl. the **enumeration test** (same body and the same models touched for five inputs); undeliverable notices; one audit scenario per Phase 2.2 action |
| `test/accounts/*` | Frozen accounts (the phone off the account and login, recovery, never reopened for the number's new holder); deletion, legal hold, erasure (tombstone, stripped mail and invites, audit untouched, hold vs erase race), overdue erasures |
| `test/api/*` | API v0 (ADR 0025): a registry row per endpoint drives the matrix (no token, the other token kind, a missing permission, another compound's id, invalid input, a malformed id); one happy path per area with its exact response keys; Swagger lists exactly the registry, every operation a draft, and the committed OpenAPI file is current; enumeration over HTTP (byte-identical public answers, verify included); a PII leak scan of every GET as six personas (the guard included); capabilities vs endpoints; no-store on every secret; erased accounts everywhere; secrets never in the logs |
| `test/api/*` (Phase 4) | Notifications (paging, counts, own rows only, rollback, retention, erasure, scrubbing); gates and shifts (one open shift, idempotent start/end, deactivation); visitor passes (who may invite, the primary's view, cap, cancel, idempotent replay with a fresh code, host leaving, retention); verify, entries and inside (every refusal, unknown and foreign codes identical, overnight schedules across time zones, backdating, client ids, rate limit, unconfirmed exits); approvals (recipients, first decision wins, deny until entry, every standing instruction on timeout, withdraw, workers off schedule); worker notices and attendance |
| `test/idempotency/*` | Idempotency-Key on a test-only probe route: replay, concurrent duplicates, payload mismatch, failed actions, lost bodies, a route that forgets to claim, purge |
| `test/gate/*` | `gate_entries` immutable for the app and the owner; one audit scenario per Phase 4 action; the gate's races under `Promise.all` (approve vs deny, deny vs entry, two guards on one pass, the pass cap, two shift starts) |
| `test/rls/gate-isolation` | Every Phase 4 tenant table: cross-tenant reads, updates, deletes and inserts refused; composite keys (except the append-only log, which has none) |
| `test/files/*`, `test/api/files` (Phase 4.2) | Object storage on MinIO (ADR 0029): the store refusing another size or type and a second PUT, a private bucket, a stopped store as 503; the upload flow for every type and purpose, limits and uploaders, finalize before the upload, disguised bytes, expiry, owner-only access and RLS, delete (object then row), the pending cap under `Promise.all`, finalize racing finalize and delete; the sweep (expired uploads, a store that would not delete, rows a finalize holds); erasure, and an erasure that rolls back; one audit scenario per files action; worker photos (registration with a photo and a language, the card, the manager's detail, the guard's verify for a valid code or QR only, a known worker keeping their photo, replacement, the uploader's erasure, retention) |

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

- Top-level codes live in `src/core/common/errors.ts` (`UNIT_NOT_FOUND`, `ROLE_LOCKOUT`, `DUPLICATE_RESOURCE`, …), and field codes there too (`FIELD_REQUIRED`, `INVALID_PHONE`, `DUPLICATE_VALUE`, …).
- Code in `src/` throws only `AppException` (`appError.notFound(...)` etc.); a unit test fails on any other exception type.
- Database errors are mapped. A duplicate returns `DUPLICATE_RESOURCE` + the field. Anything unexpected returns `INTERNAL_ERROR` without database text.
- The OTP email is Arabic (RTL) or English, chosen from `Accept-Language` (default Arabic). Accounts and admins carry `preferred_locale`.

## Access control

Four layers, each enforced in exactly one place:

1. **Tenant:** Postgres RLS (ADR 0005).
2. **Account and compound status:** checked on **every request** by `PermissionsGuard`. A deactivated account or suspended compound is rejected immediately, not when the 15-minute token expires.
3. **Permissions (ADR 0010):**
   - The catalog and default roles are defined in code (`src/core/access/permissions.ts`, `default-roles.ts`).
   - Each compound has its own copy of the `manager`, `resident`, `family_member` and `guard` (staff, ADR 0028) roles (one default role per account type; a staff account may name another staff role with `roleKey`); a manager can edit his compound's role permissions (`RolesService`). `access:sync` also creates default roles a compound does not have yet.
   - Routes declare `@RequirePermissions('units.read')`. Permissions are not in the JWT; they are cached in Redis under `perm:{tenant}:{role}:{version}`, and every edit bumps the version, so changes apply on the next request.
   - The manager role can never lose `roles.manage` / `residents.manage`.
   - To remove or rename a permission, list it in `RETIRED_PERMISSIONS` / `RENAMED_PERMISSIONS`; `access:sync` never infers removal.
4. **Resource (ADR 0012, 0016):**
   - `ResourceAccess` limits a resident to units he actively occupies, and a family member to units with an active membership. A miss is `UNIT_NOT_FOUND`, never `FORBIDDEN`.
   - On top of that, household actions need the unit's primary resident or a live delegate (`HouseholdAuthority`), and worker actions need an occupant or a `workers` delegate (`WorkersAuthority`).

## Audit trail (ADR 0014)

Three append-only tables:

| Table | Scope | Written |
|---|---|---|
| `audit_log` | Compound (RLS) | In the transaction of the action (fail-closed) |
| `platform_audit_log` | Global | In the transaction of the platform action |
| `security_events` | Global | On its own, fail-open (a logging failure never blocks a login), capped by `SECURITY_EVENT_TIMEOUT_MS` |

- **Immutable:** `jiwar_app` has only `SELECT, INSERT`, and triggers reject `UPDATE`/`DELETE`/`TRUNCATE` for every role, the owner included. The owner can still `DISABLE TRIGGER` with DDL; this is a documented limit, and hash chaining is the deferred fix.
- **Catalog** (`src/core/audit/actions.ts`): every audited action and security event is declared there with its target type. A unit test fails if one is never emitted, and the coverage suite fails if one has no scenario.
- **Recording:**
  - `AuditService.record(tx, { action, targetId, changes, metadata })` requires the action's transaction.
  - The compound is taken from that transaction; the actor (account / platform admin / system) and the IP, user agent and request id come from the request context.
  - `diffChanges(before, after, action)` records only changed fields.
- **No personal data by value:**
  - Names, national IDs, phones, emails and secrets are stored as `{ changed: true }`; screens show names by joining `actor_id`/`target_id` to `accounts`.
  - A sensitive key in `metadata` throws.
  - A value that merely looks personal is replaced by `"[redacted]"` with a warning; tests throw instead.
- **Security events** store only the identifier HMAC, never an email or phone.
- **Reading:** `AuditQueryService` (current compound, permission `audit.read`), `PlatformAuditQueryService` and `SecurityEventsQueryService` page with opaque `(occurred_at, id)` cursors, served at `GET /audit` (compound; no IP or user agent) and `GET /platform/audit`, `GET /platform/security-events`.
- **Changing a login phone/email** (`ResidentsService.updateContact`) re-keys the login lookup and invalidates every pending OTP code for that account in the same transaction, so a code already sent to the old address stops working.

## Platform super admin (ADR 0011)

The platform owner is not a tenant account. It manages compounds and their managers (`TenantsService`: create, list, suspend/reactivate, add/deactivate managers) and **cannot read data inside a compound**.

- It logs in with email + password (argon2id); every failure returns the same error, with rate limits and a lockout.
- The first login forces a password change. The restricted token issued for that is accepted only by routes marked `@PlatformAuth({ allowPasswordChange: true })`.
- Platform and tenant tokens use different secrets and audiences, and each guard rejects the other's tokens.
- Endpoints live under `/api/v1/platform` (`auth/login`, `auth/change-password`, `auth/refresh`, `auth/logout`, `tenants…`, `audit`, `security-events`).

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
  core/          shared by every domain; never imports one (ADR 0015)
    config/      zod env schema
    common/      request context (CLS), guards, error filter + codes, validation mapping, locale, uuid
    database/    PrismaService.tenant, TenantTx, GlobalDbService — the only DB access paths
    access/      permission catalog, default roles, PermissionsGuard, RolesService, ResourceAccess
    auth/        tenant login: identifiers, OTP (+ email templates), sessions
    accounts/    manager-created accounts; AccountWriter (the one place accounts are written); freeze and erasure (ADR 0023)
    platform/    super admin auth + guard + bootstrap, compounds (TenantsService), access:sync
    audit/       audit catalog, diff + personal-data guard, audit/platform/security services, query services
    redis/       Redis client, rate limiter
    health/      readiness (db, redis, tenant-setting leak canary)
    mail/        the pooled SMTP transport, the bilingual layout, the template registry and the outbox (ADR 0019)
    sweep/       the in-app sweep; domains register idempotent tasks (ADR 0021); forEachTenant walks the compounds
    notifications/  the in-app inbox: a catalog of kinds, Notifier, /me/notifications (ADR 0027)
    idempotency/ Idempotency-Key claimed in the action's transaction (ADR 0028)
    tenant-settings/  per-compound settings (household approval, size limit)
  gate/          the gate domain (ADR 0028): gates, shifts, visitor passes, verify, entries, approvals, attendance;
                 reads community only through CommunityGatePort (src/community/index.ts)
  community/     the community domain; other domains import only its index.ts
    units/       units, scoped by ResourceAccess; the unit row lock
    residents/   residents, occupancies and capacities, the primary resident, unit states, self-registration (ADR 0020, 0021, 0024); /me units
    households/  household members, invites and acceptance, delegation, member permissions, majority (ADR 0016, 0021)
    workers/     domestic workers, engagements, access codes, notices, compliance, card incidents (ADR 0017, 0022)
    capabilities/  capabilitiesFor: what someone may do on a unit, read by later domains (ADR 0020)
    notices/     the Phase 2.2 community notice templates (ar/en) and their sender
prisma/        schema, migrations (RLS SQL inside), seed
docker/        postgres init (roles)
test/          rls/, access/, platform/, residents/, audit/, db/, auth/, settings/, community/, mail/ suites + setup/
docs/decisions ADRs
docs/api       the OpenAPI contract (openapi.v0.json) and v0-notes.md
```

Rules the code enforces:
- **Import boundaries** (ADR 0015): `src/core/` never imports a domain; a domain imports another one only through its `index.ts` (ESLint, `eslint.boundaries.cjs`, proven by a unit test).
- **Tenant data** goes through `prisma.tenant.<model>` (single queries) or `withTenantTx` (multi-statement work and raw SQL). The raw Prisma client cannot be imported outside `src/core/database/` (ESLint).
- **`runInTenantUnsafe`** takes the tenant from the caller, not the request. It is allowed only in `src/core/auth/`, `src/core/platform/`, `prisma/seed.ts` and the files named in `eslint.config.mjs`: invite acceptance and registration (before anyone is logged in), and the sweep tasks that walk every compound (ESLint). New sweep tasks use `SweepRunner.forEachTenant`, the one allowed helper.
- **Core reaches domains only through hooks** (`AccountLifecycle`: deactivation, freeze, reactivation, erasure; `SweepRunner`; `EmailTemplates`), never imports.
- **Reasons** for every rejection, revocation, freeze and suspension are `{ code, text }`: the code from a closed list goes into the audit trail, the text only to the record and the notice (`core/common/reasons.ts`).
- **Never silent:** a notice with nobody to receive it is recorded as undeliverable (`Outbox.recordUndeliverable`), never skipped.
- **`tenantId` comes from the token only.** It never appears in a request DTO, and unknown body fields are rejected.
- **Errors** are thrown only as `AppException`, with a code (unit test).
- **Audit entries** are written only through `AuditService` / `PlatformAuditService`, with the action's transaction. Bypassing the immutability triggers (`session_replication_role`) is allowed only in `test/` (unit test).
