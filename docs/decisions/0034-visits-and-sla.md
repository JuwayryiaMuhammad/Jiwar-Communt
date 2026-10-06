# 0034 — Visits and the SLA: windows, absence-entry consent, the receiver, event-sourced clocks, the lock order

**Status:** Accepted · Phase 5.3

## Context

ADR 0032 built tickets and ADR 0033 the dispatch engine. 5.3 adds two things:

- **Visits:** when the technician comes to a unit, who lets them in, and whether they may enter while nobody is home.
- **An SLA:** response and resolution targets, measured from append-only events.

A visit's window, its consent and its receiver tell **when a home is empty**. Most of the decisions below come from that.

ADR 0032 promised that 5.2 and 5.3 add tables and change none of its own. 5.3 keeps that promise for the schema: migration `20261009090000_visits_and_sla` creates six tables and seven enums and alters nothing. It does add **one action** to a 5.1 ticket: changing its category (below).

## Decisions

### What 5.1 already had, reused as is

- **Rating:** confirming a ticket takes a rating of 1 to 5 and a comment, stored in `ticket_feedback`, one row per cycle and verdict. Nothing is added; the technician never sees ratings or comments.
- **Photos at completion:** the technician attaches `after` photos while `in_progress` or `on_hold` (ten per cycle), then reports the work done. Nothing is added.
- **Escalation:** a second rejection or reopen goes back to the queue (`ticket.escalated`). Resident escalation is deferred.
- **Hold reasons:** `awaiting_resident` and `awaiting_parts` are the reasons the SLA pauses on. `other` does not pause.
- **Cycles:** `cycle` and `rejection_count`. The SLA tells a rejection (`from = completed`) from a reopen (`from = closed`).
- **The technician's transitions:** `WorkService.moveInTx` is the technician's `start` and `hold`, extracted from them. A visit's arrival and its `no_access` go through it, so they write the same history row and the same notices.

### One funnel: `TicketLog`

Every status change and every assignment, from every path, passes through `TicketLog.status` and `TicketLog.assignment`: a request, the dispatch engine, a lifecycle release, a role change, the auto-close sweep. `TicketLog` now takes handlers (`onStatus`, `onAssignment`), as core's lifecycle hooks do. They run in the change's transaction, under its ticket lock, after the history row; `ticket` is the row as it was before the change.

The SLA recorder and the visits' lifecycle register there. No path can forget them, and core never imports maintenance.

### Visits

- **Unit tickets only.** A common-area ticket has none (409 `VISIT_NOT_FOR_COMMON_AREA`).
- **While a technician holds the ticket:** the new ticket action `visit` is allowed in `assigned`, `in_progress` and `on_hold`.
- **A window:** `starts_at` and `ends_at`.
  - The end is after the start, at most 4 hours later. A CHECK enforces both.
  - The start is at least 15 minutes from now and within 30 days. This is checked against **the database's clock**, read after the ticket's lock (`dbNow`). A CHECK must not call `now()`.
- **At most one active visit per ticket** (`proposed`, `confirmed` or `arrived`). Writes check this under the ticket lock, and a partial unique index (`ticket_visits_one_active_per_ticket`) backs it. The loser gets 409 `VISIT_ALREADY_ACTIVE`.
- **Proposals:**
  - The technician, or a dispatcher acting for them, proposes. The `technician` side records who proposed (`proposed_by_account_id`).
  - The other side confirms, or counter-proposes. A counter ends the proposal as `rescheduled` with no code and links the new one (`previous_visit_id`).
  - A side never confirms its own proposal (403 `VISIT_SAME_SIDE`).
  - A **confirmed** window that moves is a new proposal by either side, with a code from `visitChange`. The old visit ends `rescheduled` with that code.
  - Either side cancels a proposed or confirmed visit, with a code from `visitChange`.
  - The other side is told (`ticket.visit_proposed`, `ticket.visit_confirmed`, `ticket.visit_cancelled`).
- **At the door:**
  - **Arrival.** The technician marks it within [start − 30 min, end + 2 h] (409 `VISIT_OUTSIDE_ARRIVAL_WINDOW` otherwise). The residents are told (`ticket.visit_arrived`). An `assigned` ticket starts through the 5.1 transition. The answer is the technician's view of the visit, with consent read after the lock: what they may do is what was true when they arrived.
  - **`done`.** The visit is over; the ticket goes on by its own rules.
  - **`no_access`.** Only from `arrived`, and allowed whatever the consent: consent permits entry but does not guarantee it, and key handover is deferred. An `in_progress` ticket goes `on_hold` with `awaiting_resident` through the 5.1 hold, so the SLA pauses. A ticket already on hold is left as it is. The residents are asked for a new time (`ticket.visit_no_access`).
- **Response:** a proposal from the technician's side is a response to the ticket (below).

### Who reaches a ticket's visits

| Audience | Routes | Reach |
|---|---|---|
| Residents | `/tickets/:id/visits…`, `/me/units/:unitId/visits` | Those who see the ticket (ADR 0032) and may still act on it (`tickets` now, to read as well as to write), **or any adult who lives in its unit** (`visitConsent`, an active account). One who sees the ticket but has neither gets 403 `TICKETS_NOT_ALLOWED`: a reporter who left still reads the ticket (ADR 0032), never its visits. The second group reaches the visits **without the ticket**: its description, photos, messages and feedback stay as ADR 0032 decides. `GET /me/units/:unitId/visits` lists a unit's active and upcoming visits with the ticket number, category and status; anyone else gets `UNIT_NOT_FOUND` or 403 `VISITS_NOT_ALLOWED`. |
| The technician | `/technician/tickets/:id/visits…` | The ticket's technician now, and only their own visits. |
| Dispatch | `/maintenance/tickets/:id/visits…` | Every visit, and the history (`/visit-events`). |

Guards, other technicians, landlords and anyone whose occupancy ended reach nothing. Visit notices go to the residents' side: **every adult who lives in the unit, plus the reporter while they still have `tickets` on the unit**, checked in the transaction that writes the notice. A reporter who left is told nothing: "never to anyone who left" (§Privacy) wins.

### Absence-entry consent

- **Not confirmation.** `absence_entry_approved` is false unless someone who lives there said so, on a **confirmed** visit. The API never implies it.
- **Who grants it:** an adult who lives in the unit with an active account. That is the new capability **`visitConsent`** (amends ADR 0020):
  - a residing occupant, owner or tenant (the `daily` rule);
  - an active adult member with an account.

  Never a landlord, a non-residing owner, a minor (who has no account), a pending or removed member, or an ended occupancy. Like `gateEntry`, no review takes it away. Frozen and erased accounts are refused by the active-account check (`CommunityMaintenancePort.mayConsent`).
- **Who revokes it:** any of the same people, until the technician arrives. When someone other than the primary grants it, the primary is told (`ticket.visit_consent_granted`, the window only) and may revoke it.
- **Never carried over.**
  - A cancelled or rescheduled visit loses it (`consent_voided`).
  - So does a visit whose granter no longer may grant it: they left, or were deactivated, frozen or erased (`consent_voided`, `granter_left`).
  - At the door, consent stays on the record of a visit that happened.

### The receiver

- Set by a resident on a confirmed visit: an adult who lives in the unit (kind `household`), or an active domestic worker of the unit (kind `worker`, its engagement).
- Cleared when a household receiver leaves, is deactivated, frozen or erased, through the account hooks.
- Community has no hook for engagements. A worker receiver is therefore **checked live** at every read, as the gate does (ADR 0028): one whose engagement ended or was suspended, or who was banned, reads as no receiver.
- The technician sees the receiver's **first name and kind** only.

### Automatic ends

These are `VisitLifecycle`'s `TicketLog` handlers, with system codes from `visitSystem`:

- **The technician changes or is released.** Any assignment row whose `from` is set and differs from its `to`: a decline, a reassignment, every ADR 0033 release (deactivation, freeze, erasure, a lost `tickets.work`, the sweep's reconciliation). The visit is cancelled `technician_changed`.
- **The ticket is cancelled or closed:** `ticket_cancelled` / `ticket_closed`.
- **The work is reported done.** A proposed or confirmed visit is cancelled `ticket_completed`; it would only block the next one. An arrived visit is `done`.

The consent is void, and the residents are told (`ticket.visit_cancelled`). A visit already at the door is `done` whatever ended the work.

### Late visits

A one-minute sweep (`maintenance.visit_late`) finds confirmed visits not arrived 15 minutes after their start, in active compounds. Each is noticed **once**:

- it is claimed with `late_notified_at` (`UPDATE … WHERE late_notified_at IS NULL`, `SKIP LOCKED` against an arrival holding the row);
- a `late_notified` event is written;
- the residents and the dispatchers get `ticket.visit_late`.

A rerun, another instance or a retry tells nobody twice.

### The visit's history

`ticket_visit_events` is append-only like the other history tables: SELECT and INSERT for the app, the immutability triggers for every role, no foreign keys. Each row holds the visit, the ticket, the kind, the side and account (null for the system), a reason code and the time.

- **No window times:** the history says who confirmed, granted or cancelled, not when a home was empty.
- Dispatchers read it with full names.
- Visits are **never in the audit log**, not even a dispatcher's cancellation.

### The SLA

- **Targets** per category × priority (`sla_targets`; `maintenance.manage`; audited as `ticket_category.sla_targets_changed`):

  | Priority | Response | Resolution |
  |---|---|---|
  | emergency | 60 min | 24 h |
  | urgent | 4 h | 72 h |
  | normal | 24 h | 7 days |

  - Every category gets these defaults: the seeded ones, one created later (in its creation transaction), and every existing one (backfill).
  - A CHECK keeps response between 5 min and 7 days, resolution between 15 min and 30 days, and response ≤ resolution.
  - A running clock keeps its target. Editing a target changes clocks started afterwards.
- **The switch** (`maintenance_sla_settings.sla_enabled`) is **off in every compound**, new and backfilled, like automatic dispatch. While it is off, nothing is recorded and nobody is told. `enabled_at` is the current activation.
- **Clocks, per ticket and SLA cycle:** `response` and `resolution`. The SLA's cycle is not the ticket's: a new one starts at creation, at a **reopen**, and at the first write after an activation. A **rejection keeps it**.
  - **Response** starts at creation. It is met by the first technician-side visit proposal or the first `in_progress`, whichever comes first. An assignment alone is not a response.
  - **Resolution** starts at creation.
    - At `completed` it pauses (`awaiting_confirmation`): the time waiting for the resident's verdict does not count.
    - A rejection resumes the **same** clock (`rejected`).
    - A close (confirmed or auto-closed) records `met`. It measures the time up to the completion.
  - **Holds:** both clocks pause on hold with `awaiting_resident` or `awaiting_parts`, and resume when the ticket leaves that hold (`left_hold`), by resuming, a reassignment or a release.
  - **Cancellation** stops every clock (`stopped`, `ticket_cancelled`).
  - **Retarget:** a priority or category change writes `retargeted` on the cycle's open clocks, measured from the same start. A running clock that is then already past due is breached at the retarget's time.
  - The clock is 24/7; business hours come later.
- **Events, append-only** (`ticket_sla_events`, the immutability triggers): clock, kind (`started`, `paused`, `resumed`, `met`, `breached`, `retargeted`, `stopped`), SLA cycle, `seq`, `at`, target minutes, and a reason code from `slaEvent` where relevant.
  - Unique indexes allow **one `started` and one end (`met`, `breached` or `stopped`) per clock**, so `met` and `breached` can never both be written.
  - **Elapsed time is computed from the events** (the sum of the running intervals), never kept as a counter.
- **The projection** (`ticket_sla_clocks`: state, target, `started_at`, `due_at` while running, `paused_at`, `ended_at`) is the fold of the clock's events (`sla-fold.ts`, a pure function). It is rewritten in the same transaction as each event. A test rebuilds every clock in the database from its events and compares.
- **Time decides, not who writes first.**
  - Every SLA write happens under the ticket's lock, timed by the database clock read after it.
  - A clock past its due time is breached **at exactly its due time**, by whoever writes next: the sweep, or a request that would have met it (a start of the work one minute late is a breach, not a response).
  - Stops that are not a judgement (`sla_disabled`, `new_cycle`) never turn into a breach.
- **The breach sweep** (`maintenance.sla_breach`) runs every minute, through a new `SweepRunner` option that gives a task its own interval.
  - Compounds with the SLA on and **not suspended** only.
  - Each overdue clock is handled in a transaction of its own, under its ticket's lock.
  - Dispatchers and managers (holders of `tickets.dispatch` and of `maintenance.manage`) get `ticket.sla_breached`, or **`ticket.sla_breached_emergency`** (critical) for an emergency. The params are the ticket number and the clock only.
- **Turning it on or off never locks every ticket.**
  - The switch is one short transaction (`enabled_at` by the database clock).
  - After it commits, the request starts a **pass**: bounded batches (50 × 40), each ticket in a transaction of its own under its own lock. The pass starts the current activation's clocks of every measured ticket (not closed or cancelled), or stops the open ones.
  - Any ticket write that finds the SLA on and no current clock starts one there, under the lock, at the database's now: **never backdated**. Response starts only if the ticket has not been responded to since it was opened or last reopened; resolution starts paused on a pausing hold or while completed.
  - Writers read the switch after their ticket lock and write nothing while it is off.
  - The breach sweep also runs one activation or stop batch per compound per minute, so a pass that died or a large compound is finished without anyone waiting.
  - Re-enabling stops what an earlier activation left open (`sla_disabled`) and starts a new cycle.
- **Who sees it.**
  - Residents see `sla` on their ticket view: `responseDueAt` and `resolutionDueAt` while running, and `paused`. It is null while the SLA is off.
  - Dispatch also sees each clock's state, and the events (`GET /maintenance/tickets/:id/sla-events`).
  - The technician's view has no SLA.

### Changing a ticket's category

`POST /maintenance/tickets/:id/category` (`tickets.dispatch`) is a correction, allowed like a priority change (open or completed). It takes a code from `ticketCategory` and is audited as `ticket.category_changed` (category keys and the code).

- The new category must be active, and allow a common area when the ticket is one.
- **The assigned technician keeps the ticket** and is told (`ticket.category_changed`: the number and the new category's key).
- **The engine does not run:** the ticket is not in the queue because of its category. A dispatcher who thinks it needs someone else reassigns it.
- **The SLA retargets** to the new category's targets.
- The reporter sees the new category on the ticket.

### The lock order

The order everywhere is **account rows (in id order), then ticket rows (in id order), then visit and clock rows**.

- A resident's visit write shared-locks their own account first (`lockSelf`). A receiver write shared-locks the receiver's account too, **before** the ticket.
- Every visit write takes the ticket's lock before it reads the visit, so writes on one ticket's visits never interleave.
- A deactivation, freeze or erasure updates the person's account row first. A change of who lives where (`onResidenceChanged`) locks it `FOR NO KEY UPDATE` before voiding consents and clearing receivers on the tickets concerned, which it locks in id order.
- The SLA's pass and sweep lock one ticket at a time; the switch's row is never locked by a writer, only read after its ticket lock.
- Visits and the SLA never take the dispatch advisory lock.

**The one exception** is ADR 0033's engine. It locks a queued ticket, then each candidate technician's account `FOR SHARE`. It cannot deadlock:

- whoever holds a technician's row exclusively only locks the tickets **in that technician's hands**, never a queued one: a deactivation, freeze, erasure, role change or availability change;
- a manual assignment's `FOR SHARE` on the technician does not conflict with the engine's `FOR SHARE`;
- the visit hooks only lock tickets with an active visit, and a queued ticket has none (a release ends it).

`visit-lock-order.e2e-spec.ts` holds the first lock of each pair, starts the competing request, and takes the second lock the way the real path does. A wrong order would be a deadlock, and Postgres would abort one side.

### Races

| Race | Serialized by | Outcome |
|---|---|---|
| Two proposals | the ticket lock, and the partial unique index as a backstop | one visit; the other gets 409 `VISIT_ALREADY_ACTIVE` |
| Confirm vs cancel | the ticket lock | confirmed then cancelled, or cancelled and the confirmation gets 409 |
| Arrive vs revoke | the ticket lock; revoke needs `confirmed` | arrived with consent and the revocation too late (409), or revoked and arrived without; the arrival's answer always says which |
| An automatic end vs a confirmation or a consent | the release paths already lock the ticket | the end comes first or after, never inside |
| Consent or a receiver vs the person leaving | the account row, then the ticket | refused after, or voided after |
| Met vs breached | the ticket lock, the time rule and the one-end index | exactly one, at the due time if breached |
| The late sweep vs an arrival | the visit row; `SKIP LOCKED` | late noticed once or never |
| SLA activation vs a ticket write | each takes the ticket's lock; the unique `started` index | one cycle, never two |

### Privacy

- A visit's window, consent and receiver go to the assigned technician (their own visits), dispatch, and the residents who reach the visits (above). Never to guards, other technicians, landlords, or anyone who left — not even the ticket's reporter.
- Never in the audit log; never in the visit's own history (window); never in a notification beyond the window.
- **Visit notices carry the ticket number and the window only: no unit code** (unlike other ticket notices; a window with the unit says which home is empty when). No consent or absence wording in their params.
- SLA notices carry the ticket number and the clock.
- The technician sees `absenceEntryApproved` and the receiver's first name and kind: never who granted, never the receiver's id.
- Residents see the granter's first name and whether it was them. Dispatch sees full names, never phones.
- An erased person stays a pointer to the tombstone (`{ id, erased: true }`). Visits hold no free text.
- No location tracking.
- The test time machine (`test/setup/sla.ts`) rewrites append-only history as a superuser; `src/` cannot import from `test/` (`SRC_TO_TEST` in `eslint.boundaries.cjs`).

### Endpoints

| | Permission |
|---|---|
| `GET /tickets/:id/visits`; `POST /tickets/:id/visits/:visitId/{confirm,counter,reschedule,cancel}`; `POST`, `DELETE …/absence-consent`; `PUT`, `DELETE …/receiver` | `tickets.create` (and the reach above) |
| `GET /me/units/:unitId/visits` | `tickets.create`, `visitConsent` on the unit |
| `GET`, `POST /technician/tickets/:id/visits`; `POST …/:visitId/{confirm,counter,reschedule,cancel,arrive,done,no-access}` | `tickets.work` (the ticket's technician) |
| `GET`, `POST /maintenance/tickets/:id/visits`; `POST …/:visitId/{confirm,counter,reschedule,cancel}`; `GET …/visit-events` | `tickets.dispatch` |
| `GET /maintenance/tickets/:id/sla-events`; `POST /maintenance/tickets/:id/category` | `tickets.dispatch` |
| `GET`, `PATCH /maintenance/sla-settings`; `PUT /maintenance/categories/:id/sla-targets` | `maintenance.manage` |

Every visit read and the arrival are no-store. There is no new permission, so `access:sync` has nothing to add.

## Consequences

- **This amends ADR 0032:**
  - the SLA is not "computed from `ticket_status_history`"; it has its own event log;
  - a category may be changed;
  - every adult who lives in a unit reaches its tickets' visits (not the tickets).
- **This amends ADR 0020:** a new capability, `visitConsent`.
- **This amends ADR 0033:** a release also ends the ticket's visit.
- The SLA measures 24/7. Business hours, a pre-breach warning, reminders before a visit, resident escalation, live tracking and key handover are deferred.
- A worker receiver is checked live: until community has an engagement hook, a worker who no longer qualifies stays on the row but reads as no receiver everywhere (the technician never sees them).
- Turning the SLA on in a large compound starts clocks over a few seconds after the answer; a breach on a ticket whose clock had not started yet cannot happen (no clock, no breach), and nothing is backdated.
