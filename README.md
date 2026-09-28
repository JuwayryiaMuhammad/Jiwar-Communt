# Jiwar Community Backend

Backend for Jiwar, a multi-tenant platform for managing residential compounds. **One tenant = one compound.** Compound management creates accounts for residents and staff; people log in with their email or phone and a one-time code sent by email.

This is **Phase 0**: the project skeleton and the proof that tenant isolation holds (Postgres row-level security + Prisma + request context), exercised through accounts, units and the login flow. Architecture decisions live in [`docs/decisions/`](docs/decisions/README.md).

Stack: Node ≥ 22, pnpm, NestJS 11, Prisma 7 (`@prisma/adapter-pg`), PostgreSQL 17, Redis 7, Jest + Supertest.

## Setup

```bash
corepack enable pnpm          # once per machine
pnpm install
cp .env.example .env          # defaults work with docker-compose
docker compose up -d          # postgres :5435, redis :6381, mailpit :1025/:8025
pnpm db:migrate               # apply migrations as jiwar_migrator
pnpm seed                     # two demo compounds (idempotent)
pnpm start:dev                # http://localhost:3100/api/v1
```

- API docs (Swagger): http://localhost:3100/docs — disabled when `NODE_ENV=production`.
- Emails (OTP codes): http://localhost:8025 (Mailpit).
- Ports are shifted from the usual ones so this project runs next to Jiwar-Hub-backend.

## Database roles

`docker/postgres/init.sql` creates two roles and two databases (`jiwar`, `jiwar_test`) on first start of an empty volume:

| Role | Used by | Rights |
|---|---|---|
| `jiwar_migrator` | Prisma CLI only (`MIGRATOR_DATABASE_URL`, via `prisma.config.ts`) | Owns every table |
| `jiwar_app` | The running app (`DATABASE_URL`) | SELECT/INSERT/UPDATE/DELETE only. Not an owner, not a superuser, no `BYPASSRLS` |

Tenant tables (`accounts`, `units`) have `ENABLE` + `FORCE ROW LEVEL SECURITY` with a policy on `tenant_id = current_setting('app.tenant_id')`. The policies are hand-written SQL at the end of the migration, because Prisma cannot express them. Changing the init script requires recreating the volume: `docker compose down -v`.

## Migrations

All migration commands run **as the migrator**. `prisma.config.ts` points the CLI at `MIGRATOR_DATABASE_URL`, and the app never uses that URL.

```bash
pnpm db:migrate:dev --name <change>   # create + apply in development
pnpm db:migrate                        # apply pending migrations (deploy)
```

For a new tenant-scoped table: add `tenant_id`, create the migration with `--create-only`, and append the `ENABLE`/`FORCE`/`CREATE POLICY` block (copy it from the init migration) before applying. `FORCE` also applies to the migrator, so a migration that changes **data** in tenant tables must `set_config('app.tenant_id', …, true)` per tenant inside its transaction (ADR 0005).

## Environment variables

See `.env.example` for the full list with comments. The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Runtime connection as `jiwar_app` |
| `MIGRATOR_DATABASE_URL` | Prisma CLI connection as `jiwar_migrator` |
| `TEST_DATABASE_URL`, `TEST_MIGRATOR_DATABASE_URL`, `TEST_REDIS_URL` | e2e tests (separate database, Redis db 1) |
| `DB_POOL_MAX` | pg pool size |
| `REDIS_URL` | OTP rate limits and login tickets |
| `SMTP_*`, `MAILPIT_API_URL` | OTP email delivery; Mailpit API for tests |
| `JWT_ACCESS_SECRET` | Access-token signing key (≥ 32 chars) |
| `IDENTIFIER_PEPPER` | HMAC key for login identifiers and OTP codes (≥ 32 chars). Rotating it invalidates every login identifier |
| `OTP_*` | Code TTL, max attempts, rate limits |
| `OTP_FIXED_CODE` | **Development only.** Every code becomes this value (emails are still sent). The app refuses to start with it when `NODE_ENV=production` |

The app validates the environment with zod at startup (`src/config/env.schema.ts`) and reads `process.env` only. Entry points (`main.ts`, the seed, the tests) load `.env` themselves.

## Tests

```bash
pnpm test         # unit + e2e (needs `docker compose up -d`)
pnpm test:unit    # src/**/*.spec.ts, no infrastructure
pnpm test:e2e     # test/**/*.e2e-spec.ts against real Postgres, Redis and Mailpit
pnpm lint
pnpm build
```

The e2e run migrates `jiwar_test` as the migrator and truncates it, then connects only as `jiwar_app`. `OTP_FIXED_CODE` is removed for the run, so login tests read real codes from Mailpit.

`test/rls/` is the Phase 0 exit-criteria suite:

| File | Covers |
|---|---|
| `db-isolation.e2e-spec.ts` | 1–5: cross-tenant reads and writes, fail-closed without a tenant, `WITH CHECK`, 200 interleaved A/B operations on a single-connection pool, misuse guards, and `jiwar_app` unable to disable or bypass RLS |
| `http-isolation.e2e-spec.ts` | 1 over HTTP, plus `tenantId` in a body → 400, roles, neutral 409 |
| `login-bootstrap.e2e-spec.ts` | 6–7: no cross-tenant data during login, identical responses for unknown identifiers, one person in two tenants, code invalidation, refresh rotation and reuse detection, deactivation |

## Login flow

```
POST /api/v1/auth/otp/request   { identifier }            → 202, same body whether or not it exists
POST /api/v1/auth/otp/verify    { identifier, code }      → { loginTicket, accounts: [{ accountId, tenantName, accountType }] }
POST /api/v1/auth/select-account { loginTicket, accountId } → { accessToken (15 min), refreshToken, … }
POST /api/v1/auth/refresh       { refreshToken }          → new pair (rotation; replaying an old token revokes the session)
POST /api/v1/auth/logout        { refreshToken }          → 204
```

1. The identifier is an email or a phone (local Egyptian `010…` or international `+…`). It is normalized (lowercase email, E.164 phone) and looked up by HMAC in the global `login_identifiers` table, which holds no personal data.
2. A 6-digit code is emailed to the email on each matching account. When a phone matches accounts with **different** emails, each email gets its own code, and a code unlocks only the accounts behind its email. A new request invalidates older codes, and each code allows 5 attempts and lives 5 minutes.
3. When several accounts match (e.g. a resident in one compound who is also a manager in another), the user picks one. The access token carries `sub` (account), `tid` (tenant) and `typ` (account type), and every query of that session is confined to that tenant.
4. Refresh re-checks that the account is still active. Deactivating an account (`PATCH /accounts/:id/status`) revokes its sessions at once.

Try it after `pnpm seed`, with `OTP_FIXED_CODE=123456` in `.env`: request a code for `01000000003` (the shared demo person). Verify with `123456` and you get two accounts, one in each compound. Select one, then call `GET /api/v1/units` with the access token.

## Project layout

```
src/
  config/      zod env schema
  common/      request context (CLS), guards, error filter, error codes, uuid
  database/    PrismaService.tenant, TenantTx (withTenantTx), GlobalDbService — the only DB access paths
  auth/        identifiers, OTP, sessions, OtpChannel + email implementation
  accounts/    manager-created accounts
  units/       first tenant-scoped entity
  health/      readiness (db, redis, tenant-setting leak canary)
prisma/        schema, migrations (RLS SQL inside), seed
docker/        postgres init (roles)
test/rls/      isolation suite
docs/decisions ADRs
```

Rules the code enforces:
- **Tenant data:** `prisma.tenant.<model>` for single queries, `withTenantTx` for multi-statement work and raw SQL. The raw Prisma client cannot be imported outside `src/database/` (ESLint).
- **`runInTenantUnsafe`** takes the tenant from the caller instead of the request, and is allowed only in `src/auth/` and `prisma/seed.ts` (ESLint).
- **`tenantId` from the token only:** it never appears in a request DTO, and unknown body fields are rejected.
