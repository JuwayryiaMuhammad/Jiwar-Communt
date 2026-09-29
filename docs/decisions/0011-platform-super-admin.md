# 0011 — Platform super admin

**Status:** Accepted · Phase 1a

## Decision
- The super admin is the platform owner. It is **not** a tenant account and does not live in `accounts`: separate global tables `platform_admins` and `platform_sessions`, a separate JWT secret (`PLATFORM_JWT_SECRET`) and audience (`aud: 'platform'`), and a separate guard. The tenant guard rejects platform tokens and vice versa.
- **It manages compounds only**: create, list, suspend, reactivate, and manage each compound's manager accounts (it sees managers' name, email, phone and status — they are the platform's customers). **It cannot read data inside a compound** (units, residents, occupancies): no service method exposes it. Support access to a compound is a future feature with a written reason and an audit trail.
- Writes inside a compound (creating the tenant's roles and first manager) use `runInTenantUnsafe`, whose lint allowance extends to `src/core/platform/**`.
- Suspending a compound revokes every session in it; the auth flows and `PermissionsGuard` reject accounts of a suspended compound.

## Authentication
- Email + password (argon2id). Any failure — unknown email, wrong password, locked, disabled — returns the same generic error; unknown emails are verified against a dummy hash so timing does not reveal them.
- Rate limits per IP and per email; lockout after N consecutive failures (`locked_until`).
- `must_change_password` → login returns only a short-lived restricted token that is accepted solely for changing the password. Changing it requires the current password and revokes all platform sessions.
- Access tokens are shorter-lived than tenant tokens; refresh tokens rotate with reuse detection, like tenant sessions.

## Bootstrap
On startup: no platform admin and `SUPERADMIN_EMAIL` + `SUPERADMIN_PASSWORD` set → create it with `must_change_password`. One exists → nothing (never updated from env). Neither → warning; the app still starts. After the first production login, remove the password from the environment.
