# 0038 — The resident's ticket screens: arrival confirmation, the technician on the way

**Status:** Accepted · Resident journey (Figma, "الساكن")

## Context

The resident journey in Figma shows ticket and visit steps that ADR 0032 and ADR 0034 do not have. This ADR adds them one at a time, on top of 5.3. Each section below is one change. None of them takes anything away from an existing route or view.

## Decisions

### The residents confirm the arrival

The design shows "Ahmed says they're at your door · Confirm arrival": the technician marks the arrival, and someone at home says it is really them.

- `POST /tickets/:id/visits/:visitId/confirm-arrival` (`tickets.create`), for whoever reaches the ticket's visits (ADR 0034): those who see the ticket and may still act on it, or any adult who lives in its unit. Anyone else gets `TICKET_NOT_FOUND`, like every visit route.
- **Only at the door:** the visit must be `arrived` (the new visit action `confirmArrival`). Before the arrival or after `done` / `no_access` it is 409 `VISIT_INVALID_TRANSITION`.
- **Once:** `arrival_confirmed_at` and `arrival_confirmed_by_account_id` are set together, and a second confirmation is 409 `VISIT_ARRIVAL_ALREADY_CONFIRMED`. The check runs under the ticket's lock, so two at once give one 204 and one 409. A CHECK (`ticket_visits_arrival_confirmed_shape`) ties the two columns together and to an arrival.
- **Nothing else moves.** The arrival already started the ticket (ADR 0034). A confirmation is an acknowledgement, not a gate: the technician is not blocked waiting for it, and a visit nobody confirmed is not an error. Disputing an arrival ("that is not our technician") is out of scope; the residents call the gate.
- The history gets an `arrival_confirmed` event (resident side). The technician is told (`ticket.visit_arrival_confirmed`, the number and the window only, like every visit notice).
- **Views:**
  - residents (`/tickets/:id/visits` and `/me/units/:unitId/visits`): `arrivalConfirmedAt` and `arrivalConfirmedBy` (first name, `mine`);
  - the technician: `arrivalConfirmedAt` only, never who;
  - dispatch: `arrivalConfirmedBy` (full name) and `arrivalConfirmedAt`.

### The technician on the way

The design's progress line reads "Sent · Assigned · Technician on the way · In progress · Done", with a time on each step.

- **A new ticket status, `en_route`,** between `assigned` and `in_progress`. The technician sends it with `POST /technician/tickets/:id/en-route` (`tickets.work`, their own ticket), from `assigned` only (the new ticket action `enRoute`).
- **Optional, so nothing breaks:**
  - `start` still works from `assigned`, and now from `en_route` too;
  - `en_route` allows everything `assigned` allows: decline, the reporter's cancel, a reassignment, a release, visits, messages, report photos, priority and category changes.

  A technician app that never sends the new action never produces the status, and every 5.1–5.3 path behaves as before.
- **It is work in the technician's hands** (`IN_HAND`): a deactivation, freeze, erasure or role loss releases it (ADR 0033), dispatch's reconciliation finds it, and the database requires a technician (`tickets_technician_matches_status` now lists it; its own migration, because a new enum value cannot be used in the transaction that adds it).
- **Workload:** an en-route ticket weighs like one in progress (`weightInProgress`). The settings keep their three weights, so the dispatch-settings API is unchanged.
- **The SLA (ADR 0034):** the first `en_route` meets the **response**, like the first `in_progress` or a technician-side visit proposal. A technician heading to the unit has responded. The reasoning that "assignment alone is not a response" still holds: `en_route` is the technician's own act, not the dispatcher's.
- **Visits:** an arrival starts an `assigned` or `en_route` ticket.
- **Who is told:** the reporter (`ticket.status_changed` with `status: en_route`), like every technician move. The history row is the 5.1 `ticket_status_history` row (`assigned → en_route`), so the resident's timeline has its time.
- No location tracking: "on the way" is a status, not a position.

## Consequences

- This **amends ADR 0034**: a visit gains a resident-side action at the door, and two columns (`ticket_visits` was a 5.3 table). The SLA's response is also met by `en_route`.
- This **amends ADR 0032**: the status list gains `en_route`, and one CHECK is replaced to include it. Clients that switch over `status` must handle the new value; it only appears once a technician app sends the new action.
- This **amends ADR 0033**: `en_route` is open work and weighs like `in_progress`.
