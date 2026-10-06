# 0032 — Maintenance tickets: statuses, history, manual dispatch, confirmation and reopen, messages, visibility

**Status:** Accepted · Phase 5.1

## Context
Residents need to report what is broken at home or in the compound, follow it, and say whether it was fixed. Technicians need their work and nothing else. Someone has to decide who does what. Maintenance comes in three phases:

- **5.1** (this one): tickets, categories, photos, manual assignment, the technician's workflow, history, messages, confirmation, rejection and reopen.
- **5.2:** the dispatch engine (specialties, availability, weighted automatic assignment).
- **5.3:** visits with absence consent, and the event-based SLA.

After 5.1 alone, maintenance works end to end with manual assignment. 5.2 and 5.3 add tables and change none of these.

## Decisions

### A domain of its own
- `src/maintenance/` is the third domain (ADR 0015). It imports core freely and the community domain **only through `src/community/index.ts`**: `CommunityMaintenancePort` gives it units and their codes, an account's capabilities on a unit (`tickets`, ADR 0020), the units where it may open tickets, and the unit's primary. The lint forbids it from importing the gate at all, not even through the gate's index (`NO_IMPORT` in `eslint.boundaries.cjs`).
- The capability scans (`holders` and `unitsWhere`) moved from the gate's port into `CapabilitiesService`, and both ports call them.
- **A new compound** gets maintenance's defaults in its creation transaction through a new core hook, `TenantLifecycle.onCreated`. Core cannot import the domain (ADR 0015 rule 4). The defaults are five categories, a settings row and a ticket counter. Existing compounds got the same from the migration's backfill.

### Roles and permissions
- `tickets.create` goes to the resident and family roles. The resource check is the `tickets` capability on the unit, so a landlord and a family member without the `tickets` member permission are refused (`TICKETS_NOT_ALLOWED`, 403).
- `tickets.work` goes to the new **technician** role. `tickets.dispatch` goes to the new **maintenance_supervisor** role **and the manager**, so a compound without a supervisor still works. `maintenance.manage` (manager) covers categories and settings.
- Both new roles are staff-kind system roles, created through `POST /accounts` with `roleKey`. The catalog's rule "one default role per kind" became **"exactly one `kindDefault` per kind"**. `guard` stays the staff default, so a staff account created without `roleKey` is unchanged (amends ADR 0010, 0028). `access:sync` creates the two roles in existing compounds.
- "Managers see everything" means **`tickets.dispatch` holders**, which managers are by default. There is no separate read permission.

### Categories and settings
- **`ticket_categories`** is compound data, not an enum: key (immutable), `name_ar`, `name_en`, default priority, `common_area_allowed`, `active`. A retired category is `active: false`, never deleted, because tickets point at it. The five seeded categories (plumbing, electrical, ac, carpentry, general) all allow a common area: a corridor leak is plumbing. ADR 0013's "no display strings for system data" does not apply here: these names are the compound's own data from the moment they are seeded.
- **`maintenance_settings`**, one row per compound: `auto_close_hours` (72), `reopen_days` (7), `max_report_photos` (5).

### A ticket
- **Where:** a unit, or a common area (a label of at most 120 characters until common areas have a table), never both.
  - A unit ticket needs `tickets` on that unit.
  - A common-area ticket needs `tickets` on any unit.
- **Who:** `created_by` opened it and `reporter` is whose problem it is.
  - A resident is both.
  - A dispatcher may open a ticket on a resident's behalf. The reporter must be someone who could have opened it themselves (`REPORTER_NOT_ELIGIBLE`), it is audited, and the reporter is told.
- **Priority:** normal, urgent or emergency. The category's default applies when none is chosen. A dispatcher may change it with a reason code (audited).
  - An emergency, at creation or by a change, sends a **critical** notification to every `tickets.dispatch` holder.
- **Number:** `MT-000123`. It comes from the compound's `ticket_counters` row through `INSERT … ON CONFLICT DO UPDATE … RETURNING` in the creating transaction. The row lock serializes creations, a rollback gives the number back, and a unique index backs it. Numbers are distinct and grow; gaps are tolerated, duplicates never.
- **Two statuses**, tied together by CHECKs:
  - `status`: new → assigned → in_progress ⇄ on_hold → completed → closed, or cancelled;
  - `confirmation_status`: null until the first completion, then `pending` while completed, `confirmed` or `auto_closed` when closed, and `rejected` after a rejection or reopen, until the next completion.
  - `on_hold` carries `hold_reason` (`awaiting_resident`, `awaiting_parts`, `other`), which 5.3's SLA will pause on.
  - `cycle` starts at 1. `cycle` and `rejection_count` both grow by one on every rejection and every reopen.
- **One table of rules** (`ticket-rules.ts`) says which status allows which action, and every service checks it after taking the ticket's row lock. A unit test covers every status × action cell.

### History, not audit
- **`ticket_status_history`** (from, to, actor or null for the system, reason code, cycle) and **`ticket_assignments`** (from, to, by, type, reason code, **cycle**) are append-only like `gate_entries` (ADR 0028): SELECT and INSERT for the app, triggers refusing UPDATE, DELETE and TRUNCATE for every role, and no foreign keys.
- A ticket's own status changes and assignments are recorded there, **not duplicated in `audit_log`**.
- **Audited** are the admin actions:
  - categories (`ticket_category.created`, `ticket_category.updated`);
  - settings (`maintenance.settings_changed`);
  - `ticket.created_on_behalf`;
  - `ticket.priority_changed`;
  - `ticket.cancelled`.

  Codes and ids only, never free text.
- **Assignment types** are `manual`, `reassignment`, `declined`, `released` and `automatic`.
  - `automatic` is reserved for 5.2 and never written now.
  - **`released`** is a system unassignment (no actor):
    - `escalated`: a second or later rejection or reopen sends the ticket back to the queue;
    - `technician_unavailable`: the technician was deactivated, frozen or erased, or could no longer take back a first rejection.

  Without it, the record of who held the ticket would have gaps.

### Manual dispatch and the technician
- **Assign** takes a ticket from the queue (`new`). **Reassign** needs a reason code and puts the ticket back to `assigned`, because the new technician starts the work; the old one loses access at once and is told.
- A technician is an active staff account holding `tickets.work`. Anyone else is `TECHNICIAN_NOT_FOUND`.
- **Locks:** an assignment shared-locks the technician's account row, then locks the ticket. A deactivation, freeze or erasure updates the account row and then, through `AccountLifecycle`, releases the technician's tickets in hand to the queue in the same transaction. So no assignment can land on a technician whose deactivation is committing, and no ticket is left with a technician who cannot work. Completed and closed tickets keep their technician.
- **The technician's workflow:**
  - start → in_progress;
  - hold with a reason → on_hold, and resume;
  - complete → completed with `pending`, and the reporter is asked to confirm;
  - before starting, decline with a reason code → back to `new`. Dispatchers are told, and the `declined` row is what 5.2 will exclude.
- **Photos** are the new file purpose `ticket_photo` (JPEG, PNG or WebP, 5 MB; uploaded by `tickets.create` or `tickets.work` holders). Attached files move to the ticket and lose their owner, so the uploader's erasure leaves them (ADR 0029).
  - Report photos: from the reporter or creator while the ticket is open, up to `max_report_photos`.
  - Before and after photos: from the technician while working, ten per cycle together.
  - Both caps are counted under the ticket's row lock.

### Confirmation, rejection, reopen, cancel
- **Confirm** (the reporter or creator): a rating of 1 to 5 and an optional comment, giving closed/confirmed. The comment is content for dispatch, never audited.
- **Reject** (a reason code and a note) and **reopen** (within `reopen_days` of closing; `TICKET_REOPEN_WINDOW_PASSED` after) take **one path**:
  - `cycle + 1` and `rejection_count + 1`;
  - the first time, the ticket goes back to the technician who did the work, if they can still take it, and dispatchers are told;
  - any later time, it goes back to the queue, and dispatchers are told as an escalation.

  **The note becomes the reporter's message in the thread**, in the same transaction. It is never a response field (ADR 0025 returns no free-text reasons), the technician reads it where they coordinate, and an erasure finds it with the person's other messages. `ticket_feedback` keeps one row per cycle and verdict (confirmed, rejected, reopened) with the code, the rating and the comment.
- **Auto-close:** the `maintenance.auto_close` sweep closes completed tickets that nobody answered within `auto_close_hours` (closed/auto_closed, actor system) and tells the reporter.
  - It claims rows `FOR UPDATE SKIP LOCKED`, so a confirmation or rejection holding the row wins and the sweep leaves it.
  - A confirmation that waited behind the sweep finds the ticket closed (409).
  - Until the sweep runs, a late confirmation or rejection is still accepted.
- **Cancel** needs a reason code and is audited.
  - The reporter or creator may cancel while the ticket is `new` or `assigned`.
  - A dispatcher may cancel any time before it is closed. A cancelled completion clears `pending`.
- Resident writes (cancel, confirm, reject, reopen, messages, photos) need `tickets` on the ticket's unit **now**, or on any unit for a common area. Reads do not.

### Messages
- `ticket_messages`: sender, body, `internal`, `deleted_at`.
  - The reporter, the creator, the unit's primary, the current technician and dispatchers post.
  - An **internal** message is for staff (the technician and dispatch) and never reaches a resident; the residents' routes have no `internal` field at all.
  - No message is accepted on a closed or cancelled ticket.
- Everyone who may read a message is told (`ticket.message`), never with its words.
- **Erasure (ADR 0023)**, in the erasure's transaction:
  - the person's message bodies are nulled and `deleted_at` set;
  - their confirmation comments are nulled;
  - `sender_account_id` stays a pointer to the tombstone, rendered `{ id, erased: true }`;
  - tickets, descriptions and photos stay: the ticket is the unit's maintenance record.

  A post or a confirmation shared-locks its sender's account row, and an erasure locks that row first, so no body lands after an erasure has nulled the others.

### Who sees a ticket
| Audience | Routes | Sees |
|---|---|---|
| Residents (`tickets.create`) | `/tickets…` | The tickets they created or reported, and every ticket of a unit they are the primary of now. The technician and the reporter by first name; `onBehalf` as a flag, never who. No internal message. |
| The technician (`tickets.work`) | `/technician/tickets…` | Only the tickets assigned to them now: unit code or label, category, priority, description, photos, the reporter's **first name**. Message senders by first name, **with no account id** (an erased one is `{ erased: true }`), and `mine` for their own. Never a phone, an email, a document, the history, who declined, ratings or comments. |
| Dispatch (`tickets.dispatch`) | `/maintenance/tickets…` | Everything in the compound, with full names but no phone or email (account endpoints exist for that); the history and the assignment trail; feedback. |

Anything else is **`TICKET_NOT_FOUND`**: one answer for an unknown id, another compound's ticket and an invisible one. Details carry presigned photo URLs and are no-store.

### Notifications
The ticket number, the unit code (never for a common area: the label is free text) and codes only:

- `ticket.assigned` and `ticket.unassigned`;
- `ticket.status_changed`;
- `ticket.completed`, which asks the reporter to confirm;
- `ticket.rejected`, `ticket.reopened` and `ticket.escalated`;
- `ticket.declined` and `ticket.technician_unavailable`;
- `ticket.priority_changed`;
- `ticket.emergency` (critical);
- `ticket.message`;
- `ticket.auto_closed`;
- `ticket.opened_on_behalf`.

A reporter who no longer has `tickets` on the ticket's unit (they left, or lost the permission) gets **no** `ticket.*` notice as its reporter. Visit notices still reach them only while they live there, as any adult of the unit does (ADR 0034). It is checked in the transaction that writes the notice. A common-area ticket has no unit to lose.

### Idempotency
Ticket creation (both routes) and message posts honour `Idempotency-Key` (ADR 0028). Their responses carry no description and no body, so no free text is stored with the key.

## What 5.2 and 5.3 add
- **5.2** (ADR 0033): specialties and availability tables, and an engine that writes `automatic` assignments. It excludes a technician with a `declined` row on the ticket, in every cycle.
- **5.3:** visits with absence consent, and an SLA computed from `ticket_status_history`. Hold reasons pause it, and priorities and categories set targets.

Neither changes these tables.

## Consequences
- Every dispatcher is told of every message on every ticket; per-account notification preferences come with the design (ADR 0027).
- Dispatch never sees a reporter's phone. Whether an emergency should show it is a design decision (`docs/api/v0-notes.md`).
- A technician whose role loses `tickets.work` keeps the tickets assigned to them until a dispatcher reassigns them; only deactivation, freezing and erasure release them automatically. *(Superseded by ADR 0033: losing `tickets.work` now releases them too.)*
