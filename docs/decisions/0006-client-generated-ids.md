# 0006 — Client-generated IDs

**Status:** Accepted · Phase 0

## Decision
- Primary keys are **UUIDv7 generated in the application** (`uuid` package), not by the database. Time-ordered, so index locality stays good.
- Clients may later propose IDs (offline creation). **An ID never grants authorization and is never a source of truth**: the server always checks tenant, ownership, permission, idempotency, version and conflict state.
- A primary-key collision returns a neutral `409` that reveals nothing about the existing row.
