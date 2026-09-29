# 0005 — RLS mechanics

**Status:** Accepted · Phase 0 (proven by `test/rls/`)

## Roles
- `jiwar_migrator` owns every table and runs migrations (`MIGRATOR_DATABASE_URL`, used only by the Prisma CLI).
- `jiwar_app` is the runtime role (`DATABASE_URL`): not an owner, not a superuser, `NOBYPASSRLS`, DML grants only.

## Policy
Every tenant-scoped table:
```sql
ALTER TABLE x ENABLE ROW LEVEL SECURITY;
ALTER TABLE x FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON x
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```
With no tenant set the comparison is against NULL: reads return nothing and writes fail `WITH CHECK` (fail-closed).

## Setting the tenant
The tenant is set with `set_config('app.tenant_id', <id>, true)` — **transaction-local** — as the first statement **inside the same transaction** as the queries. Never a session-level `SET`: a pooled connection must not carry one request's tenant into the next.

Access paths (all in `src/core/database/`):
- **`PrismaService.tenant`** — a Prisma extension that wraps every model operation in a batch transaction `[set_config, query]`. The tenant comes from the request context (CLS); without one it throws and runs nothing. `$transaction`, `$queryRaw*` and `$executeRaw*` are removed from its type and throw at runtime: a nested transaction per query would deadlock a pool of one and escape the outer transaction on a bigger pool. It also throws when called inside `withTenantTx`, where `tx` must be used.
- **`TenantTx.withTenantTx(fn)`** — an interactive transaction on the base client: `set_config` first, then `fn(tx)`. The only way to run multi-statement units of work or raw SQL.
- **`TenantTx.runInTenantUnsafe(tenantId, fn)`** — same, with an explicit tenant. Allowed only in `src/core/auth/` and `prisma/seed.ts` (ESLint `no-restricted-properties`).
- **`GlobalDbService`** — the only path to the global tables (`tenants`, `login_identifiers`, `otp_challenges`, `sessions`).
- The base client is private to `src/core/database/` (ESLint `no-restricted-imports`).
- `tenantId` never appears in a request DTO; it is taken from the context only.

## Operational note
`FORCE ROW LEVEL SECURITY` applies to `jiwar_migrator` too. Any future migration that changes **data** in tenant tables must run `set_config('app.tenant_id', …, true)` per tenant inside its transaction. Schema-only migrations are unaffected.

## Lazy queries and the request context
Prisma queries are lazy: they execute when awaited, and the tenant hook reads the context at that moment. Code must therefore `await` a tenant query inside the context that owns it (`cls.run(async () => await …)`). Returning an un-awaited query out of the context fails closed with `TenantContextMissingError` — found and pinned down by the spike. Inside an HTTP request the whole handler runs in one context, so this only matters for code that opens its own context (jobs, scripts, tests).

## Update (Phase 1a)
- New tenant tables: `roles`, `role_permissions`, `tenant_permission_catalog`, `unit_occupancies` — same policy, covered automatically by a test that checks every table with a `tenant_id` column (the global exceptions `login_identifiers` and `sessions` are listed explicitly).
- New global tables: `platform_admins`, `platform_sessions` (through `GlobalDbService` only).
- Links between tenant tables use composite foreign keys that include `tenant_id`, because foreign-key checks bypass RLS.
- `runInTenantUnsafe` is additionally allowed in `src/core/platform/**` (ADR 0011).

## Update (Phase 1b)
- `audit_log` is a tenant table (RLS + FORCE). `security_events` is global and carries `tenant_id` as a pointer, so it joins `login_identifiers` and `sessions` on the RLS-coverage allowlist; `platform_audit_log` is global.
- `jiwar_app` has only `SELECT, INSERT` on the audit tables; triggers reject `UPDATE`/`DELETE`/`TRUNCATE` for every role. Test cleanup clears them over a superuser connection in `test/` only.

## Update (Phase 2)
- **`invite_tokens`** joins the allowlist of global tables that carry `tenant_id` as a pointer: it resolves a household invite link before anyone is logged in, and holds only the token HMAC.
- **`runInTenantUnsafe`** is additionally allowed in exactly one domain file, `src/community/households/invite-acceptance.service.ts`, for the same reason (ESLint names the file).
- **No DELETE for the app** on the household and worker tables, whose records are never deleted; `invite_tokens` rows are deleted on acceptance or revocation.
- **Paths moved** with the domain split (ADR 0015); the rules did not change.
