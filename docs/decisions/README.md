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
