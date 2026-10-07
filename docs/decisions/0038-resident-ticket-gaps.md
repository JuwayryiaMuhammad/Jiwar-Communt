# 0038 — The resident's ticket screens: arrival confirmation, the technician on the way, visit slots, two ratings, where in the unit, overdue and escalation, preventive maintenance

**Status:** Accepted · Resident journey (Figma, "الساكن")

## Context

The resident journey in Figma shows ticket and visit steps that ADR 0032 and ADR 0034 do not have. This ADR adds them one at a time, on top of 5.3. Each section below is one change. None of them takes anything away from an existing route or view, with one exception that is a fix: a visit proposal whose start has passed can no longer be confirmed.

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

### A proposal whose start has passed cannot be confirmed

Nothing expires a `proposed` visit, and until now `confirm` did not look at the time: a proposal nobody answered could be confirmed after its start, and the late sweep fired on it at once.

- `confirm` (all three routes) reads the database's clock after the ticket's lock and refuses a proposal whose start is not in the future: 409 `VISIT_WINDOW_PASSED`, nothing written.
- The way on is `counter` (a new window) or `cancel`; both still work on a stale proposal.
- There is still no expiry sweep. A stale proposal stays the ticket's active visit until one side answers it.
- **This narrows 5.3:** a request that was accepted is now a 409. It is a fix, and the only place this ADR refuses something that used to work.

### Overdue, and the residents' escalation

The design's list of reports shows "3h left of the promised response time", an "Overdue" badge, and "Request escalation →" on an overdue report. ADR 0034 deferred resident escalation.

**Overdue, defined once** (`sla-overdue.ts`, a pure function the views and the endpoint share):

- A commitment of the ticket's **current SLA cycle** is overdue when it is **late and still unmet**.
  - Late: its clock is `breached`, or it is `running` and its due time has passed **by the database's clock**. The read does not wait for the breach sweep, and writes nothing.
  - Unmet: the response, until the ticket is responded to (`en_route`, `in_progress`, or a visit proposed by the technician's side, since it was opened or last reopened); the resolution, until the work is reported done.
- So a late response that was then given is no longer overdue, and a ticket that is `completed`, `closed` or `cancelled` never is.
- A paused clock is never past due (it has no due time). One that breached before the pause stays late.

**What the residents see**, on the list and on the detail:

- `sla`, now on the list rows too, with a new `overdue` beside `responseDueAt`, `resolutionDueAt` and `paused`;
- `escalatedAt`: this SLA cycle's escalation, or null;
- `canEscalate`: what the endpoint would answer the caller now. The app does not rebuild the rules, and could not: one of them is whether the caller may still act on the unit.
- A page costs a fixed number of queries whatever its size (the clocks, the responded tickets and this cycle's escalations in one query each; the caller's `tickets` once per distinct unit). A test counts them.

**The escalation:** `POST /tickets/:id/escalate` (`tickets.create`, no body, `Idempotency-Key` honoured).

- **Who:** anyone who sees the ticket (ADR 0032) and has `tickets` on its unit now, like every resident write. Not seeing it is `TICKET_NOT_FOUND`; seeing it without `tickets` is 403 `TICKETS_NOT_ALLOWED`.
- **Under the ticket's lock, in this order:**
  1. the ticket's running clocks already past due are breached **at their due time** (`SlaRecorder.settle`, the same `breach` the sweep and every writer use): time decides, not who writes first (ADR 0034);
  2. the ticket is open: `new`, `assigned`, `en_route`, `in_progress`, or `on_hold` **unless it waits for the residents** (`awaiting_resident`: the next move is theirs). Otherwise 409 `TICKET_INVALID_TRANSITION`;
  3. it is overdue, else 409 `TICKET_NOT_OVERDUE` (also while the SLA is off, or the ticket has no clocks);
  4. it was not escalated in this SLA cycle, else 409 `TICKET_ALREADY_ESCALATED`.
- **Once per SLA cycle.** `ticket_escalations` (the ticket, the SLA's cycle, the account, the time) is append-only like the other ticket histories: SELECT and INSERT for the app, the immutability triggers, no foreign keys. A unique index on the ticket and the cycle backs the rule. A reopen starts a new SLA cycle, so a reopened ticket may be escalated again.
- **What it does:** the dispatchers and managers (holders of `tickets.dispatch` and of `maintenance.manage`, as for a breach) get `ticket.resident_escalated`, with the ticket number only. It is audited (`ticket.escalated_by_resident`: the SLA cycle and which clocks were overdue). **Nothing else changes:** not the priority, the technician, the status or the clocks.
- **An emergency** sends `ticket.resident_escalated_emergency` instead, which is **critical**. This is a one-line amendment to ADR 0036's list of critical kinds: it joins `ticket.sla_breached_emergency` there, and `kinds.spec.ts` pins the list.
- **Two notices at once, on purpose.** When step 1 breaches a clock, the same people get `ticket.sla_breached` and `ticket.resident_escalated` together. The breach is a fact of its due time that the sweep would have announced within the minute; hiding it would make the notices depend on who wrote first.
- **A retry:** with the same `Idempotency-Key`, the 204 is replayed and nothing is written twice. Without a key, `TICKET_ALREADY_ESCALATED` after a lost answer means it went through.
- **Dispatch** reads `escalations` on the ticket's detail: the SLA cycle, who, and when.

### Preventive services

The design's "Request preventive maintenance" starts with "What": AC service, Water heater, Plumbing check, Electrical check.

- **`preventive_services`** is the compound's own list, like its ticket categories: a key, two names, a position, `active`, and **the category** whose technicians do the check-up (so the dispatch engine needs nothing new). Never deleted, because preventive tickets will point at them; `active = false` retires one.
- **The key is the manager's**, with the categories' pattern, and never changes. A duplicate is 409 `DUPLICATE_RESOURCE` on `key`.
- **The order is `position`, then the key.** The four defaults are 1 to 4, in the design's order. A new one goes after the others unless the manager gives a position (0 to 1000).

  A column, because creation order cannot carry it: a seed's rows share one timestamp, and ids do not sort within it.
- **Defaults** (`default-preventive-services.ts`), in the creation of a compound:

  | key | category |
  |---|---|
  | `ac_service` | `ac` |
  | `water_heater` | `plumbing` |
  | `plumbing_check` | `plumbing` |
  | `electrical_check` | `electrical` |

- **Existing compounds** get the same four from the migration: an `INSERT … SELECT` joined to the compound's categories by key, `ON CONFLICT DO NOTHING`.
  - Running it again, or after a compound was provisioned, changes nothing.
  - A compound without that category key gets no such service, quietly. That cannot happen today (categories are never deleted and their keys never change), and failing a deploy over a default would be worse.
  - A unit test keeps the list and the migration in step, and an e2e test runs the backfill again and over a compound missing a category.
- **The manager** (`maintenance.manage`): `GET`, `POST /maintenance/preventive-services`, `PATCH /maintenance/preventive-services/:id` (names, category, position, `active`). A new category must be an active one of the compound (400 `CATEGORY_NOT_AVAILABLE`). Audited as `preventive_service.created` / `.updated`, with keys and codes only: the key, the category's key, the position and `active` by value; a name only as "changed", never the words.
- **The residents** (`tickets.create`): `GET /preventive-services` lists the active services whose category is active too, with their id, key and names.

### Preventive requests

The rest of "Request preventive maintenance": a day, one of the "Available times", an optional note, "Request".

**The request**

- `POST /tickets/preventive` (`tickets.create`, `Idempotency-Key` honoured) takes `unitId`, `serviceId`, `startsAt`, `endsAt`, and optionally `note` and `unitLocation`. The answer is `TicketCreatedView`, with no note.
  - The unit reach is `POST /tickets`'s.
  - The service must be active, and so must its category; otherwise `PREVENTIVE_SERVICE_NOT_FOUND`.
- **The window** follows the visit rules by the database's clock (15 minutes to 30 days ahead, at most four hours), **and must lie inside the compound's visiting hours, on one local day** (400 `VISIT_OUTSIDE_HOURS` on `startsAt`). A counter-proposal is not held to the hours, because the other side reads it before agreeing. Nobody reads this one before it is proposed.
- **It is a ticket like any other:** kind `preventive`, the service's category, priority `normal`. Dispatch, messages, cancellation, completion, confirmation and ratings are unchanged. The dispatch lists are ordered by creation, so a ticket without clocks sorts like any other.
- **`tickets` gains** `kind` (`repair` by default, and for every existing ticket), `preventive_service_id`, `requested_starts_at` and `requested_ends_at`.
  - CHECKs: a preventive ticket has its service and both times, a repair has none of them; a preventive ticket is always a unit's; the window ends after it starts, at most four hours later.
  - **A trigger refuses any later change** to the four, for every role. No route changes them, and none may.
- **The note is the description.** A request may come without one, so `tickets.description` is nullable **for preventive tickets only** (a CHECK). **No view changes type:** `description` stays a string, and is `''` for a preventive ticket without a note.
- **Booking slots before any ticket exists:** `GET /preventive-slots?unitId=…&from=…&days=…` (`tickets.create`, the same unit reach, no-store) cuts the visiting hours into slots, 15 minutes to 30 days ahead. No technician holds the ticket yet, so nothing is busy. `days` is 1 to 14 per call, like `visit-slots`; the app pages with `from`. A read, not a reservation.

**The automatic proposal**

- When a technician takes a preventive ticket (any assignment with a technician: manual, automatic, a reassignment), the window asked for is proposed to them **from the residents' side**, while **the request still stands**:
  - every visit the ticket ever had was this automatic proposal, never confirmed, ended because the technician changed. A resident who withdrew it, a technician who cancelled or countered it, a confirmation, any other visit: the request is history, and the two sides arrange the visit as for any ticket;
  - it still starts at least 15 minutes from now;
  - the reporter may still act on the ticket (an active account with `tickets` on the unit): nobody proposes in the name of someone who left.
- **Who did it:** the visit stands on the residents' side and names the reporter as its proposer, so the technician confirms or counters it like any resident proposal. But nobody acted at that moment, so **its history row is the system's**: actor side `system`, no account, reason `preventive_request` (the new system-only list `visitProposal`). The reporter is never recorded as the actor of something they did not do then. Visits are never in the audit log (ADR 0034), so there is no audit row to attribute.
- **One handler, in order.** It runs inside `VisitLifecycle`'s assignment handler, after the old technician's visit ends, in the assignment's transaction and under its ticket lock. Not as a second handler: the order in which modules register handlers is not something to rely on. A rolled-back assignment takes the proposal with it.
- **Two notices to the technician, on purpose:** `ticket.assigned`, then `ticket.visit_proposed` (the number and the window, never the unit). They ask for different things.
- A proposal the technician never answers stays active after its start. It cannot be confirmed any more (above); the technician counters or cancels it.

**The SLA measures repairs only.** A check-up booked for next week is not late after a day. A preventive ticket never has a clock: `SlaRecorder` starts none, the activation pass does not look for one, and so it is never breached, never overdue and never escalated.

**Views:** `kind`, `preventiveService` (id, key, names; read whatever its `active`, so a retired service keeps its name), `requestedStartsAt` and `requestedEndsAt` on every ticket view: the residents', the technician's and dispatch's. Never in a notification or the audit trail: a window says when someone is home (ADR 0034).

## Consequences

- This **amends ADR 0034**: a visit gains a resident-side action at the door, and two columns (`ticket_visits` was a 5.3 table). The SLA's response is also met by `en_route`. A proposal is confirmed only before its start. Resident escalation, which ADR 0034 deferred, is here; the residents' `sla` gains `overdue` and is on the list.
- This **amends ADR 0032**: the status list gains `en_route`, and one CHECK is replaced to include it. Clients that switch over `status` must handle the new value; it only appears once a technician app sends the new action.
- This **amends ADR 0033**: `en_route` is open work and weighs like `in_progress`.
- `GET`/`PATCH /maintenance/settings` gain the three visiting-hours fields.
- This **amends ADR 0032**: a ticket has a `kind`; a preventive one may have no description (read as `''`), and what its request asked for never changes.
- This **amends ADR 0034** again: a visit may be proposed by the system for the residents' side, and the SLA measures repairs only.
- This **amends ADR 0036**: `ticket.resident_escalated_emergency` is a critical kind.
- **Migrations:** this branch's are `20261014090000` onwards, after `main`'s `20261013…`. `resident-account` (ADR 0037) is not merged yet; when it is rebased, its migrations must be renumbered after this branch's last one.
