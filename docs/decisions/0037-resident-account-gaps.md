# 0037 — The resident's unit, workers and settings screens

**Status:** Accepted · Resident journey (Figma, "الساكن")

## Context

The resident journey in Figma shows unit, worker and settings steps that the API does not have yet. This ADR adds them one at a time. Each section below is one change. None of them takes anything away from an existing route or view, and no existing permission is widened.

## Decisions

### The unit card

The design's unit card and "Data → Unit Details" show the unit's type, its area and whether it is active.

- `GET /me/units` gains `unitType`, `areaSqm` and `status` on every item, for the resident and the family member alike. No migration: `unit_type`, `area_sqm` and `closed_since` already exist (ADR 0020).
  - `areaSqm` is a string with two decimals, like `GET /units/:id`. The design shows square feet; the app converts.
  - `status` is `active`, or `closed` while the unit is in closed-unit mode.
- `GET /units/:id` keeps `units.read`. A resident reads their units through `/me/units`, which only ever lists the caller's own active occupancies and memberships, so there is nothing to check per unit and nothing of a neighbour's to leak.
- **Not done:** editing the type or the area. The primary can already fill a *missing* detail (`POST /units/:id/details`, where the manager's value wins); the design's pencil icons suggest changing an existing value too. That needs a decision about who wins (open question below).

## Open questions

- May a resident change a unit's type or area once the manager has set it, or only propose a correction?
