# 0038 — The resident's ticket screens: arrival confirmation, the technician on the way, visit slots, two ratings, where in the unit

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

### Free slots for a visit

The design's "Change visit time" shows days and "Available times" (08:00, 09:00, …): the resident picks one instead of typing a window.

- `GET /tickets/:id/visit-slots?from=YYYY-MM-DD&days=N` (`tickets.create`), for whoever reaches the ticket's visits (ADR 0034). `from` is a day in the compound's time zone (today by default); `days` is 1 to 14 (7 by default). The answer is a bounded list of `{ startsAt, endsAt }`, oldest first, no-store like every visit read.
- **Visiting hours** are the compound's: `maintenance_settings` gains `visit_hours_start`, `visit_hours_end` (minutes after local midnight) and `visit_slot_minutes`, 08:00–18:00 in one-hour slots by default (existing compounds too). The manager changes them with `PATCH /maintenance/settings` (audited with the other settings). The hours must hold at least one slot (`VISIT_HOURS_TOO_SHORT` on `visitHoursEnd`, and a CHECK), and a slot is 15 minutes to 4 hours (a visit's longest, ADR 0034).
- **A slot is offered when:**
  - it starts inside the hours, read in the compound's time zone (`tenant_settings.timezone`). A start that does not exist (a daylight-saving gap) is skipped; a slot lasts its length in real time;
  - a proposal there would be accepted now: at least 15 minutes and at most 30 days ahead, by the database's clock;
  - it overlaps none of the assigned technician's **other** active visits (proposed, confirmed or arrived). The ticket's own visit is the one being moved, so it never blocks.
- **Only while a technician holds the ticket** (the `visit` action): 409 `TICKET_INVALID_TRANSITION` in the queue, 409 `VISIT_NOT_FOR_COMMON_AREA` for a common area.
- **A read, not a reservation.** `counter` and `reschedule` take any valid window as before and check it under the ticket's lock. A slot taken in between is not refused: the technician answers the proposal like any other.
- **Privacy:** a missing slot says nothing about why. The list carries no other ticket, unit or visit, so nobody learns from it when another home is empty.
- Days off, technician working hours and travel time are not modelled: every day has the same hours.

### Two ratings at confirmation

The design's "Rate the service" asks for two ratings: the service and "The technician — Ahmed".

- `POST /tickets/:id/confirm` keeps `rating` (now described as the service's) and takes an optional `technicianRating` (a whole number, 1 to 5). The 5.1 payload is unchanged and still valid; without it, `technician_rating` stays null.
- `ticket_feedback` gains `technician_rating` and `rated_technician_account_id`: the technician who did the work, named on the row, so a later reopen, reassignment or erasure never moves a rating to someone else. A CHECK ties the two together and allows them on a confirmation only.
- **Who sees it:**
  - dispatchers and managers (`tickets.dispatch`), per ticket, in the ticket's `feedback` (`technicianRating`, `ratedTechnician`), like `rating`;
  - the technician never sees a rating on a ticket, a comment, or who rated (ADR 0032). The most a technician may ever be shown is **their own average and count**. No endpoint computes them yet, so today the technician sees nothing.

### Where in the unit

The design's "New report" asks for "Location in unit": kitchen, bathroom, living room, bedroom, balcony, other. The list and the detail show it.

- `tickets.unit_location` (enum `ticket_unit_location`: `kitchen`, `bathroom`, `living_room`, `bedroom`, `balcony`, `other`), nullable. A CHECK allows it on a unit's ticket only: a common area has no rooms.
- **Optional** `unitLocation` on `POST /tickets` and on dispatch's `POST /maintenance/tickets`. With `commonArea` it is 400 `FIELD_NOT_ALLOWED` on `unitLocation`. A ticket without it is the 5.1 one (null).
- **Every view of the ticket carries it:** the residents', the technician's (who needs it most) and dispatch's, list and detail.
- It is not free text and names nobody. It is still not added to any notification or audit row: nothing there needs it.
- No route changes it afterwards. A wrong room is said in a message.

## Consequences

- This **amends ADR 0034**: a visit gains a resident-side action at the door, and two columns (`ticket_visits` was a 5.3 table). The SLA's response is also met by `en_route`.
- This **amends ADR 0032**: the status list gains `en_route`, and one CHECK is replaced to include it. Clients that switch over `status` must handle the new value; it only appears once a technician app sends the new action.
- This **amends ADR 0033**: `en_route` is open work and weighs like `in_progress`.
- `GET`/`PATCH /maintenance/settings` gain the three visiting-hours fields.
- **Migrations:** this branch's are `20261014090000` onwards, after `main`'s `20261013…`. `resident-account` (ADR 0037) is not merged yet; when it is rebased, its migrations must be renumbered after this branch's last one.
