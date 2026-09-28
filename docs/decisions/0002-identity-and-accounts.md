# 0002 — Identity and accounts

**Status:** Accepted · Phase 0

## Decision
- **Accounts are separate per capacity**: resident, staff and manager are different accounts even when they share a phone number or email. Permissions never flow between accounts, and a session belongs to exactly one account.
- A person active in several compounds has **one account per compound**.
- **Phone and email are login identifiers, not identity keys.** Several accounts may share them (within a tenant only across different account types; across tenants freely). Uniqueness is `(tenant_id, type, email)` and `(tenant_id, type, phone)`.
- **National ID stays inside tenant data only.** It is never copied to a global table and never used to link accounts across tenants.
- Global login lookup (`login_identifiers`) stores only an HMAC of the normalized identifier plus the account/tenant ids it points to — no PII (ADR 0004).

## Consequences
- "Which account am I logging into?" is answered at login by an explicit account choice when an identifier matches more than one account.
- Linking a family member who is also a staff member is intentionally impossible; the journey documents require the two accounts to stay separate.
