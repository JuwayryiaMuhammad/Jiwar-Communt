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
