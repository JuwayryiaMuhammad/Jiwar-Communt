# 0004 — Login: email or phone, OTP by email

**Status:** Accepted · Phase 0

## Flow
1. `POST /auth/otp/request { identifier }` — the user types an email **or** a phone.
2. The server normalizes it (email: trim + lowercase; phone: E.164, default region EG), computes `HMAC-SHA256(IDENTIFIER_PEPPER, "<type>:<value>")`, and looks it up in the global `login_identifiers` table.
3. A code is emailed (see below). The response is **identical** whether or not anything matched.
4. `POST /auth/otp/verify { identifier, code }` → a short-lived single-use `loginTicket` and the list of accounts the code unlocks (tenant name + account type).
5. `POST /auth/select-account { loginTicket, accountId }` → a 15-minute access token (`sub`, `tid`, `typ`) and a rotating refresh token.
6. `POST /auth/refresh`, `POST /auth/logout`.

OTP delivery sits behind an `OtpChannel` interface so WhatsApp/SMS can be added later.

## Refinements
- **Where the email comes from.** `login_identifiers` holds no PII and `accounts.email` sits behind RLS. The auth service reads each matched account's email with `runInTenantUnsafe(row.tenantId, …)`: a system-scoped read of exactly that account, with the tenant taken from the lookup row. RLS is never bypassed; the call is lint-restricted to `src/auth/` and the seed.
- **One challenge per distinct destination email.** A phone can match accounts in two tenants with different emails. Each email gets its own code, and a code unlocks only the accounts behind the email it was sent to. Otherwise whoever owns email *a* could open the account tied to email *b*.
- **A new request invalidates older codes** for the same identifier, so repeated requests do not multiply the guess budget (5 attempts per live code).
- **Refresh re-checks the account.** Deactivating an account revokes its sessions, and `/auth/refresh` refuses an account that is no longer active.
- Codes are stored as `HMAC(pepper, "otp:<challengeId>:<code>")`; refresh tokens as SHA-256 of a 256-bit secret.
- Rate limits (Redis, fixed window) are per identifier hash and per IP, counted for unknown identifiers too, so a 429 reveals nothing.
- Token lifetimes come from a per-account-type policy (`src/auth/auth-policy.ts`), identical for all types in Phase 0, so shorter sessions for sensitive roles later are a table change.
- Development only: `OTP_FIXED_CODE` replaces the random code; the app refuses to start with it in production.

## Update (Phase 1a)
- Account and compound status are now checked on **every request** by `PermissionsGuard`: a deactivated account or a suspended compound is rejected immediately, not when the 15-minute access token expires.
- `select-account` and `refresh` also reject accounts of a suspended compound, with the same generic responses.
- The OTP email language comes from `Accept-Language` (ADR 0013).
