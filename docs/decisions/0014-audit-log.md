# 0014 — Audit log

**Status:** Accepted · Phase 1b

## Decision
1. **What is recorded:** state-changing actions and security events. Reads are not recorded yet (read-access logging for sensitive data comes with the screens).
2. **Each entry records** who (actor type + id), what (action key from a typed catalog, `src/audit/actions.ts`), on what (target type + id), when, from where (IP, user agent, request id), and the before/after of changed fields.
3. **No personal data by value.** The audit log is never deleted, so it must never hold data a person could later ask to erase. Full names, national IDs, phones, emails and any hash/token/secret/password field are recorded only as `{ "changed": true }`; screens show names by joining `actor_id` / `target_id` to `accounts` at read time (an erased account shows as a deleted user; history stays intact). Checks before every insert:
   - a sensitive **key** in `metadata` is a developer error → the write throws and the action rolls back;
   - a **value** that merely looks like personal data (email, Egyptian mobile, 14-digit national ID) is replaced by `"[redacted]"` with a warning — a heuristic must never block real work (a unit coded `01012345678` is valid). In tests it throws instead, so real leaks are caught during development.
4. **Immutable at the database level:** `jiwar_app` has only `SELECT, INSERT` on the audit tables, and triggers reject `UPDATE`, `DELETE` and `TRUNCATE` for every role, the owner included.
5. **Same transaction:** a tenant or platform audit entry is written in the transaction of the action (`AuditService.record(tx, …)` requires the transaction by type). No action without its entry; no entry for a rolled-back action. These writes are **fail-closed**.
6. **Security events are separate** (`security_events`, global): failed logins and the like often have no transaction and no known tenant. They are written on their own, **fail-open** (a logging failure is logged and swallowed; it must not block logins), **bounded by the database** (each insert runs with a transaction-local `statement_timeout`, `SECURITY_EVENT_TIMEOUT_MS`, default 500 ms: a locked or stalled table costs a login at most that much, and the cancelled query frees its pooled connection — a client-side `Promise.race`, or writing in the background, would leave the query holding its connection until the pool runs dry), store only the identifier HMAC — never a raw email or phone — and are recorded after commit when they follow a transactional action.
7. **Tables:** `audit_log` (tenant table, RLS + FORCE), `platform_audit_log` (global, `target_tenant_id`), `security_events` (global). No foreign keys: audit rows must survive anything that happens to what they reference.

## Tenant and actor of an entry
- The **tenant** comes from the transaction itself: `TenantTx` records the tenant it set with `set_config` in the context of its callback, and `record` uses exactly that. Platform and sync writes inside a compound (`runInTenantUnsafe`) therefore land in the right compound, and an entry can never be written to another tenant than its action. A transaction that did not come from `TenantTx` is refused.
- The **actor**: an explicit `auditActor` set by trusted entry points only (seed, CLIs) → otherwise the platform admin of the request → otherwise the account of the request → otherwise `system`. A `CHECK` constraint ties `actor_id IS NULL` to `actor_type = 'system'`.
- **IP** is `req.ip`. Behind a reverse proxy set `TRUST_PROXY` to the number of proxy hops (e.g. `1` for one nginx); trusting the whole `X-Forwarded-For` chain would let clients forge their IP in audit rows and rate limits.

## Known limit
The table owner (`jiwar_migrator`) can still `ALTER TABLE … DISABLE TRIGGER` and then modify rows. That is a deliberate DDL step visible in migration history, not an accident; real tamper evidence needs hash chaining (below).

## Open items
- Hash chaining for tamper evidence.
- Blocking owner DDL on the audit tables (superuser event trigger).
- Retention, and anonymization of actor references.
- Read-access logging for sensitive data.
- Export.
