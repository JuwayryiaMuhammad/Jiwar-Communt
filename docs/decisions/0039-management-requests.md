# 0039 — Talking to management: requests, their conversation, cycles and escalation, appointments, ratings, and one list of everything a resident asked for

**Status:** Accepted · Phase R2

## Context

Until now a resident could reach the management only through a maintenance ticket. A question about a bill, a letter they need, or a meeting at the office had no place. This ADR adds one: a **management request**, with a private conversation between its author and the staff, a response target per topic, appointments at the office, and a rating. It also gives the resident one list of everything they have asked for, tickets included.

Neighbour complaints and suggestions are not part of this. Real-time chat, push, business hours and voice notes are out of scope.

The model follows maintenance wherever the two meet: per-compound closed lists, a number from a counter under its row lock, a pure rules table checked under a row lock, append-only history, sweeps that claim one item per transaction, codes instead of free text everywhere outside the conversation.

## Decisions

### The request

- **One thing, three types:** `question`, `general`, `appointment`. An appointment request names its slot when it is opened; no other request has one.
- **Topics** are a closed list per compound (`management_request_topics`), each with `target_response_hours`. Seeded: `general` 48, `billing_fees` 48, `security_gate` 24, `facilities` 72, `documents` 72. Managed with `requests.manage`; never deleted, retired with `active`; the key never changes.
- **The author** is any active resident or family account of the compound, a landlord included (`requests.create`, a role permission, not a household grant). A unit is optional and, when named, one of the author's: a place there that sees the unit (ADR 0020's `unitView`). Anything else is `UNIT_NOT_FOUND`.
- **No free text of its own.** What a request says is its first message. There is no subject and no description column, so there is one rule for all of a request's text (see erasure).
- **The number** comes from the compound's counter (`management_request_counters`) under its row lock, exactly like a ticket's (ADR 0032): distinct and gapless under concurrent creation, a rollback returns it. It is rendered `MR-000123`.
- **Idempotency-Key** on opening a request, posting a message and booking or proposing a slot.

### Privacy

- **On the resident side a request is its author's alone.** Not the unit's and not the household's: the primary resident does not see a family member's request. `RequestAccess.load` answers `MANAGEMENT_REQUEST_NOT_FOUND` for an unknown id, another compound's request and one that is not the caller's — one answer.
- There is no "people who left" cutoff, because nothing is shared: an author keeps their requests wherever they live. An author who is no longer active reads nothing.
- **Staff** (`requests.handle`) see every request of the compound, the author by full name.
- **Staff notes** (`internal`) and their attachments are never returned on a resident route. Three things make it so: the resident's reads filter `internal = false` in SQL; attachments are read by message, for exactly the messages already read; and the resident's message view has no field that could carry one. A suite reads every resident GET after a note with a file and finds neither.
- **The inbox preview:** a row of the staff inbox carries `preview`, the first 120 characters of the request's first message, as written, null once that message was erased. It is on no resident route, in no audit row and in no notification.
- Every response of the phase is `no-store`.

### The conversation

- Messages (`management_request_messages`) carry `sender_side` (`resident`, `staff`), `internal`, `official`, the request's `cycle` and a body of 1 to 4000 characters. Up to five attachments each: images or PDFs up to 10 MiB, a new file purpose `request_attachment`, claimed under the file's row lock and handed to the request (no owner), like a ticket's photos (ADR 0029).
- **Messages are append-only.** A trigger refuses every UPDATE but one — the erasure that sets the body to NULL together with `erased_at`, every other column unchanged — and every DELETE and TRUNCATE, for every role. Attachments and escalations are fully append-only (the ticket histories' trigger). A rating takes the same single change, its comment to NULL.
- **The official reply** is chosen by staff when sending (`official: true`). It is a column of the message and so as immutable as the rest. A note is never official.
- Times are the database's clock, read after the request's row lock (`dbNow`), so a write that waited for the lock is timed when it decides.

### Status

`open → in_progress → answered → closed`, as one table (`request-rules.ts`). Every write locks the account row (shared), then the request (`FOR UPDATE`), reads it again and asks the table. The loser of a race gets 409 `MANAGEMENT_REQUEST_INVALID_TRANSITION` with the status it found.

- A staff reply takes an open request in hand. The official reply answers it, again each time. A staff follow-up to an answer leaves it answered.
- The author's message on an answered request puts it back `in_progress`.
- Staff may take a request in hand without writing (`start`) and close a live one with a reason code (`resolved`, `duplicate`, `not_for_management`, `other`).
- **The author withdraws** a live request: closed with the system reason `withdrawn_by_author`, no reason to pick.
- **Reopening:** the author reopens a closed request — however it closed — within seven days of the close, to the instant, with a message that says why. It is `open` again in a new cycle.
- **Auto-close:** an answered request its author does not reply to closes itself after the compound's `auto_close_days` (7) with reason `auto_closed`. The sweep `management.auto_close` takes one request per transaction with `SKIP LOCKED` and checks it again under its lock; a reply or a close holding the row wins. A new official reply starts the wait over.
- A note moves nothing: not the status, the clock or the activity time. It is the one thing staff may still add to a closed request.
- A CHECK ties `closed` to its time, reason and side, and each system reason to its side.

### Cycles and escalation

The rule is ADR 0038's — only when overdue, at most once per cycle — applied by a sweep, because here nobody presses a button.

- **A cycle** starts when the request is opened and each time it is reopened. `response_due_at` is the cycle's start plus the topic's target as it is then, fixed for the cycle; a later change of the target applies from the next cycle.
- **The clock stops at the first staff response of the cycle** (`first_response_at`): a reply, the official reply, taking the request in hand, or confirming or proposing an appointment. A note, an assignment and the author's own message are not responses. A request staff open on a resident's behalf is not answered by being taken down.
- **Overdue** is defined once (`isOverdue`): the due time has passed, nobody has responded in the cycle, and the request is still `open` or `in_progress`. The sweep, the inbox filter and the views use that one function.
- **The sweep** `management.escalation` runs every five minutes, one transaction per request: the row is taken with `SKIP LOCKED` and judged again under its lock, an escalation row is written and `escalated_at` is set. "Once" is `escalated_at` read under the lock, with the unique index on `(request, cycle)` of the append-only `management_request_escalations` as the backstop. Reopening clears `escalated_at`.
- Whoever holds `requests.manage` is told. An escalation does not move the activity time.
- Wall-clock time only.

### Assignment

- A request is assigned to one active account holding `requests.handle`, or sits in the unassigned queue. The assignee is checked under its row lock. Both ways are audited.
- **A handler who can no longer handle requests gives theirs back:** when the account is deactivated, frozen or erased, or its role loses `requests.handle` — by a manager's edit of the role, or by `pnpm access:sync` revoking a grant its kind may no longer hold — its live requests return to the queue in the transaction of that change, audited as unassigned with a reason code. Closed requests keep the name of who handled them.

### On behalf

A staff member who holds `requests.handle` and `residents.read` opens a request for a resident who called, came in or wrote, with a reason code (`resident_phone_call`, `resident_walk_in`, `resident_written_letter`). The resident is the author and sees it; who opened it and why are stored and audited. The first message is the staff member's, since they typed it.

### Appointments

- **Office hours** are weekly windows per compound (`management_office_hours`; weekday 0 is Sunday; minutes after local midnight in the compound's time zone), replaced as a whole under the settings row's lock. Seeded Saturday to Thursday, 09:00 to 17:00. The slot length (30 minutes) and the capacity of a slot (1) are settings.
- **Slots** are the windows of each local day cut by the slot length, at least an hour and at most thirty days ahead, minus the full ones. A booking names the start of an offered slot exactly.
- **Flow:** the resident picks (`requested`, waits for staff); staff confirm, or propose another slot (`proposed`, waits for the resident), who accepts or answers by picking again. Mode: `in_person` or `phone`. Either side cancels with a reason code from its own list. A slot staff book while opening a request on a resident's behalf is confirmed at once: that resident is at the desk or on the phone, not in the app.
- A request has one live appointment (a partial unique index). A new pick or proposal ends the old one as `superseded` in the same transaction. A request that closes cancels its appointment (`request_closed`, by the system) and frees the slot.
- **Capacity cannot be exceeded.** A booking takes the row lock of its slot (`management_appointment_slots`, a lock row and nothing more), counts the live appointments on that window and refuses at capacity with 409 `MANAGEMENT_APPOINTMENT_SLOT_FULL`. The settings row is share-locked for the booking, so a change of slot length or capacity waits for it. Locks are always taken in one order: account, request, settings, slot.
- **Shared slot computation.** The calendar of a local day — the time zone's wall clock, cutting a window into slots, daylight-saving gaps — moves from `visit-slots.ts` to `src/core/common/slots/day-slots.ts`. `visit-slots.ts` re-exports it and keeps its own rules; its unit spec passes unchanged. Each domain adds what is its own: maintenance one daily window and a technician's other visits, management weekly windows and a capacity.

### Rating

The author rates a closed request: 1 to 5 and an optional comment, once per request (the primary key is the request), never changed. The author reads their own. Among the staff, ratings are for `requests.manage` alone, on two routes of their own; no staff view of a request carries one, so a handler without `requests.manage` reads none anywhere.

### All my requests

`GET /me/requests` lists the caller's management requests and the maintenance tickets they can see, newest activity first, keyset-paged, each item marked `maintenance` or `management`.

- **The ordering column for tickets is new:** `tickets.last_activity_at`, kept by triggers. A new ticket starts at its `created_at`; a status or cycle change moves it to the database's clock; a non-internal message and a photo move it to their own `created_at`. It only moves forward. No maintenance code writes it.
- **Locks.** The two insert triggers update the ticket's row. Every path that inserts a ticket message or attachment already holds that row's lock, so nothing new waits and there is no new lock order.
- **Each source decides what the caller sees.** A request is its author's. Tickets are read through maintenance's own `ResidentTicketFeed`, exported from its index, on the same visibility as `GET /tickets` (one shared definition).
- **Someone who lost `tickets` on a unit** (ADR 0032) still sees their ticket and its status, and nothing written since they left. `GET /tickets` has always listed such a ticket; the feed does too. But for them a ticket that was active after that moment is ordered and dated by its last status change, so the household's later messages neither move their list nor show them a time.
- Both sources are read past the same cursor with limit + 1 and merged on `(lastActivityAt, id)`. Activity moves an item up, so an item that changes between two pages may be seen twice or not at all.

### Notifications

A new delivery category, `management`. No kind is critical. Every notice is an inbox row (ADR 0027) written in the transaction of the action, for residents and staff alike, and its params are `requestNumber` and `topicKey` only.

- For the author: `management_request.replied`, `.status_changed`, `.auto_closed`, `.opened_for_you`; `management_appointment.proposed`, `.countered`, `.confirmed`, `.cancelled`.
- For the staff: `management_request.created` (whoever handles requests), `.assigned` (the assignee), `.escalated` (whoever holds `requests.manage`), `.resident_replied`, `.reopened`, `management_appointment.requested`, `.accepted`, `.cancelled_by_resident` (the assignee, or every handler while unassigned), `.withdrawn` (the assignee alone).
- Never the one who acted, never an account that is not active. A note and a rating tell nobody.

### Audit

Every change of state is audited with ids, numbers, keys and reason codes: created, created on behalf, assigned, unassigned, started, answered, resumed, closed, withdrawn, auto-closed, reopened, escalated, rated (that it was, never how); an appointment requested, proposed, confirmed, cancelled; a topic created or updated (names as "changed" only); settings and office hours changed. A message itself is never audited: its row is its record and never changes.

### Export and erasure

- **Export** (ADR 0036): a `management-requests` section, one entry per request the account is the author of — the author's own detail with their rating, the conversation as the author's thread shows it, and every appointment. It runs as the account through the author's services and views, so a note cannot be in it. Attachments are a count per message.
- **Erasure** follows tickets exactly (ADR 0032): the person's words go — the bodies of the messages they sent and the comment of the rating they gave. The rows stay and point at the tombstone; the requests, their status and their attachments stay. What staff wrote for a resident is staff's message and stays, as a dispatcher's description of a ticket does.

## Consequences

- A new domain, `src/management`. It imports community and maintenance through their index and never the gate. Community gains a port for it (`CommunityManagementPort`).
- Three permissions: `requests.create` (resident, family), `requests.handle` (staff, manager), `requests.manage` (manager). The default manager role gets the last two and the default resident and family roles the first; no default staff role handles requests until a manager grants it. `pnpm access:sync` gives existing compounds the same.
- Eleven tenant tables, RLS enabled and forced. Migrations `20261017090000` (two enum values), `20261017090100` (the tables, with a backfill of topics, settings and office hours) and `20261017090200` (`tickets.last_activity_at` and its triggers).
- This **amends ADR 0029**: a seventh file purpose, `request_attachment`, and the content-type CHECK lets a PDF through for it.
- This **amends ADR 0036**: a sixth delivery category, `management`.
- This **amends ADR 0038** only by moving the pure calendar of a local day to core; maintenance behaviour is unchanged.
- The manager dashboard gets an inbox, a request page, an agenda of appointments and a set-up page. An account holding only `requests.handle` or `requests.manage` may sign in to it.

## Open

- An appointment whose time has passed stays `confirmed`: there is no "attended" or "no show" yet.
- Slot lock rows are never removed. They are one row per slot ever booked.
