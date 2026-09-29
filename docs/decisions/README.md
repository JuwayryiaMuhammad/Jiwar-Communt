# Architecture Decision Records

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-tenancy.md) | Tenant = compound; authorization layers | Accepted |
| [0002](0002-identity-and-accounts.md) | Separate accounts per capacity; identifiers are not identity | Accepted |
| [0003](0003-account-creation.md) | Accounts are created by an authorized actor inside the tenant | Accepted |
| [0004](0004-login.md) | Login by email or phone, OTP by email | Accepted |
| [0005](0005-rls-mechanics.md) | Postgres RLS with transaction-local tenant setting | Accepted |
| [0006](0006-client-generated-ids.md) | Client-generated UUIDv7 IDs | Accepted |
| [0007](0007-offline.md) | Offline: shared mechanics, domain-owned conflict rules | Accepted (not implemented) |
| [0008](0008-numbering.md) | Numbering: server sequences + reserved ranges | Accepted (not implemented) |
| [0009](0009-open-questions.md) | Open questions | Open |
| [0010](0010-permissions-and-roles.md) | Per-tenant roles, code-defined permissions, sync | Accepted |
| [0011](0011-platform-super-admin.md) | Platform super admin outside the tenants | Accepted |
| [0012](0012-residents-and-occupancy.md) | Residents, multi-unit occupancy, resource access | Accepted |
| [0013](0013-i18n.md) | Codes not text; Arabic and English | Accepted |
| [0014](0014-audit-log.md) | Immutable audit log and security events | Accepted |
| [0015](0015-domain-structure.md) | Domain folders (`core` + domains) and import boundaries | Accepted |
| [0016](0016-household-and-delegation.md) | Primary resident, household, invites and delegation | Accepted |
| [0017](0017-domestic-workers.md) | Domestic workers: engagements, codes, notices, ban | Accepted |
