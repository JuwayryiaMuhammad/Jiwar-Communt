# 0020 — Occupancy capacities and capabilities

**Status:** Accepted · Phase 2.2

## Context
Journey 02 names five kinds of resident, each with different screens: owner-resident, owner-landlord, tenant, occupant of a closed unit, owner of several units. Later domains (finance, governance, gate, bookings) will each need to know what someone may do on a unit. If each derives that itself, the rules drift apart.

## Decisions
- **Capacity lives on the occupancy**, never on the account (ADR 0012):

  | Capacity | Stored as |
  |---|---|
  | owner-resident | `occupancy_type = owner`, `resides = true` |
  | owner-landlord | `occupancy_type = owner`, `resides = false` |
  | tenant | `occupancy_type = tenant`, always `resides` (CHECK) |
  | occupant of a closed unit | an owner occupancy on a unit with `units.closed_since` set |
  | owner of several units | not a capacity: several occupancies, each with its own capabilities |

- **The primary resident must live in the unit.** CHECK `NOT is_primary OR resides`. The first *residing* occupant becomes primary, and a landlord never does. `setPrimary` and `setResidence` refuse a non-residing primary (`PRIMARY_MUST_RESIDE`).
- **The landlord never sees the household.** `listMembers`, the unit's workers and worker registration require a residing occupancy. This closes a gap: before, any occupant could see and act on them.
- **Tenant → owner** (`convertToOwner`) keeps history as two rows:
  - the tenant row ends with `end_reason = converted_to_owner`;
  - the owner row carries `converted_from_id`, `is_primary` and `primary_since`;
  - it never goes through `endOccupancy`, so the unit is not flagged;
  - the person is told.
- **Ending an occupancy** needs a reason code and text (`end_reason`, `end_note`), and the occupant is told. The audit keeps only the code.
- **After leaving**, capabilities give archive view, open warranty claims, and the emergency button until the manager records the handover (`handed_over_at`).
- **Closed-unit mode** (`setUnitClosed`) is set by the owner-resident primary.
- **`capabilitiesFor(subject, unitState)`** (`community/capabilities/capabilities.ts`) is the single source of these rules:
  - it is pure, one closed record of flags, with unit tests per capacity;
  - subjects are an occupancy, a household member (with grants, ADR 0021), or a pending registration (ADR 0024);
  - `CapabilitiesService.forAccountOnUnit` loads the subject and the unit state, and is the one reader other domains call, through the community index;
  - the baseline (emergency, conduct guide, contacting the primary) is never revocable;
  - a death review turns every finance flag off; a separation hides "my activity".
- **Primary-only decisions** (end the lease, transfer ownership, remove an occupant) are flags. Leases and ownership belong to their own domains; the community side has `transferOwnership` (ADR 0021).

## Audit
`occupancy.converted`, `occupancy.residence_changed`, `occupancy.handed_over`, `unit.closed_mode_changed`. `occupancy.created` now records `resides`; `occupancy.ended` records `reasonCode`.
