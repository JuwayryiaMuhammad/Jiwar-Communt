# 0012 — Residents and unit occupancy

**Status:** Accepted · Phase 1a

## Decision
- A resident can occupy **several units**, and a unit can have several residents (`unit_occupancies`).
- The **occupancy type** (`owner` | `tenant`) lives on the link, not on the account: the same person can own one unit and rent another.
- Occupancies are **never deleted**. Ending one sets `status = ended` and `ended_at`; access to that unit stops on the next request. At most one active occupancy per (unit, account) — a partial unique index.
- A resident with no active occupancy stays active (e.g. while moving between units) and simply sees no units.
- Creating a resident requires at least one unit; a person without units can still be created as a plain account.

## Resource access
`src/core/access/resource-access.ts` is the one reusable check for unit access:
- a manager may access every unit of his compound;
- a resident may access a unit only with an active occupancy on it;
- anyone else, nothing.

A resident failing the check gets **not found** (`UNIT_NOT_FOUND`), never forbidden, so unit ids are not confirmed.

## Update (Phase 2)
- Each unit has at most one **primary resident** among its active occupancies. The first occupant becomes primary; the manager can change it; when the primary leaves, the unit is flagged for a household review and nobody is promoted (ADR 0016).
- `ResourceAccess` also scopes **family** accounts: units where they have an active household membership.
- `myUnits` says whether the caller is the unit's primary, and gives the primary the household counts.

## Update (Phase 2.2)
- **Capacities** (ADR 0020): `resides` on the occupancy (an owner who does not live there is a landlord; a tenant always resides). A landlord is never primary and never sees the household.
- Ending an occupancy needs a reason code and text and tells the occupant (`end_reason`, `end_note`). Tenant → owner conversion keeps history as two linked rows. `handed_over_at` ends the archive's emergency button.
