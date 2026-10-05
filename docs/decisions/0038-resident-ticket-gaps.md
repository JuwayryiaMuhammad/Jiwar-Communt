# 0038 — The resident's ticket screens: arrival confirmation

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

## Consequences

- This **amends ADR 0034**: a visit gains a resident-side action at the door, and two columns (`ticket_visits` was a 5.3 table; no 5.1 table changes).
