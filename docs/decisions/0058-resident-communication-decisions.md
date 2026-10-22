# 0058 — The resident's side: the login history and the devices, an inbox to sort, a ticket's timeline and quote, one list of what was asked for and appealed and one search, who owns each request and when the office is open, a request to release a hold, formal notices with proof, a unit told of its credits and failed payments, and the services it is suspended from

**Status:** Accepted · Phase R11b-1 · Resident communication and decisions

## Context

The audit of 2026-10-21 listed thirty gaps on the resident's side. Most of the data already existed. Residents could not see it, or each domain kept its own version:
- a session overwrote its origin at every refresh, and a device could only be disowned, which freezes the account;
- the inbox could not be sorted, archived or cleaned;
- a ticket's history was the dispatch's alone, and nothing said what the work would cost;
- "all my requests" (ADR 0039) knew tickets and management requests, and no domain could list finance or governance, which nothing may import;
- no topic named who answers it, and residents never saw the office hours;
- a late invoice had a friendly reminder, and no notice anyone could prove was delivered or read;
- a credit note, a compensation and a failed online payment told nobody;
- a suspension said until when, never why or how to end it.

The phase is split. **R11b-1 (this ADR)** is the resident's communication and decisions. **R11b-2 (ADR 0059)** is the appeals of administrative decisions at the management and then the board, complaints against the management, and governance: representatives, agenda proposals, objections and the follow-up of decisions.

The model is the one before it:
- rules are decided under a lock, by the database's clock;
- rows move forward only, guarded by triggers;
- codes are used outside what people write;
- every tenant table is under RLS, forced, with composite foreign keys;
- audit, notifications, the outbox and idempotency carry no personal data.

**Out of scope** (approved as recommended):
- the debtor service suspension engine (its own phase);
- a place derived from the IP (ADR 0036 forbids it);
- an invoice from a quote (finance cannot be imported);
- a certificate entity (a certificate is a request on the `documents` topic);
- search history (it stays on the device).

## Decisions

### 1. The login history and the devices

- **`account_logins`.** One row per login: the account, its known device, its session, and the database's time. There is never an IP, a user agent or a place.
  - Insert-only: no UPDATE grant, and a trigger as well.
  - Kept 90 days: the sweep `account.logins_retention`.
  - It goes with the account at erasure (cascades from the devices and the sessions).
  - `GET /me/logins` returns them newest first, paged. The export has `logins.json`.
- **A known device's label** is codes only (`os`, `client`: the app or a browser family), read at login. `GET /me/sessions` gains `device`.
- **A session names its device** (`sessions.known_device_id`). It is started in the transaction that records the device, under the account's `FOR NO KEY UPDATE` lock that the alert already took.
- **`POST /me/devices/{id}/revoke`** (`GET /me/devices` lists them with their live sessions):
  - takes the same lock;
  - stamps `revoked_at`;
  - ends exactly that device's live sessions and the push tokens they registered.
  - So a racing login is wholly before (its session ends) or after (the device is live again).
  - A revoked device's next login counts as new: it alerts and clears `revoked_at`.
  - A disowned or foreign device is `DEVICE_NOT_FOUND`.

### 2. The inbox

- **`?category=`** filters by the delivery category's kinds, read from the catalog. There is no column to keep in step.
- **`archived_at`**:
  - an archived notification is read (a CHECK);
  - lists leave it out unless `?archived=true`;
  - it follows the read retention.
- **Routes:** `POST /me/notifications/{id}/archive` and `/unarchive`, and `DELETE /me/notifications/{id}`.
  - The push worker drops a delivery whose notification is gone.
  - A notification is never the record of a decision: formal notices keep their own (section 8).

### 3. A ticket's timeline and its quote

- **`GET /tickets/{id}/timeline`**: every status change, oldest first, with its time, its reason code and `by`, never a name.
  - `by` is one of `you`, `household`, `management`, `technician` (whoever was ever assigned) or `system`.
  - Someone who left the unit sees the statuses they already see.
- **`ticket_quotes`**:
  - the dispatch quotes a unit's ticket before its work starts: EGP, an optional note, one waiting at a time (a partial unique index);
  - the reporter or the unit's primary approves it, or declines it with a code (`ticketQuoteDecline`);
  - the dispatch may withdraw one that waits.
  - The terms are fixed, and a quote is decided or withdrawn once (a trigger).
- **The start rule:** the technician's start and a visit's arrival answer `409 TICKET_QUOTE_NOT_APPROVED` while a quote waits or the last one decided was declined. A withdrawn quote counts as none.
  - Every quote write takes the ticket's row lock, which the start holds, so work never starts on an unapproved quote.
  - Lock order: the caller `FOR SHARE`, then the ticket `FOR UPDATE`.
- **Routes:**
  - residents: `GET /tickets/{id}/quotes`, `POST …/{quoteId}/approve`, `…/decline`;
  - dispatch: `GET` and `POST /maintenance/tickets/{id}/quotes`, `…/{quoteId}/withdraw`.
- **Notifications:** `ticket.quote_proposed` (with `amount`), `.quote_approved`, `.quote_declined` (with `reason`), `.quote_withdrawn`.
- **Audit:** `ticket_quote.*`, with the note recorded as changed only. The export has the ticket's quotes.

### 4. The resident's lists and search: a core registry

- **`ResidentItems`** (`src/core/resident-items`) is modelled on `ExportSections` and `BoardMatters`. Each domain registers its sources with its own list route's visibility, so core lists finance and governance without anyone importing them.
  - The caller's permissions are read once, before the transaction, and handed to every source. A permission's first read loads the role and must not run inside another transaction.
- **`GET /me/requests`** moves from management to core; ADR 0039's list is widened. It lists:
  - tickets;
  - management requests (a certificate is one, on the `documents` topic);
  - invoice disputes (the unit's money, by their last move);
  - permits (the primary's unit, or the requester's own);
  - neighbour complaints (the author's own, with the author's own unit and never the one complained about).
- **`GET /me/appeals`** lists:
  - the fines' and violations' appeals at the management, on the units whose fines the caller sees;
  - the appeals to the board, the caller's own or their units' as owner or primary.
  - Each carries `appeal { state, at, decidedBy: management | board, decidedAt }`.
- **`?state=open|closed`**: closed is the archive. Each source says which of its statuses are finished.
- **Paging:** every source is read past the same cursor with limit + 1 and merged on `(lastActivityAt, id)`. Activity moves an item, so the lists are to look at, never to count with.
- **A resident without either permission** of ADR 0039's list now gets an empty list, no longer 403. Staff get 403 `FORBIDDEN` on all three routes.
- **`GET /me/search?q=`**: 2–64 characters, no LIKE wildcards.
  - It matches a reference (`MT-000123`, `mt123`, `123`: the integer number, so the unique btree serves it), or the words of a name the compound wrote (a category, a topic, a facility).
  - It never searches anyone's text.
  - At most 10 of a kind and 50 in all. Rate-limited to **30 a minute per account** (`429 RATE_LIMITED`), so references cannot be enumerated.
  - Found by the search alone: invoices, bookings, parcels and formal notices.
  - Visitor passes have no reference, and a visitor's name is personal data, so they are not searched.
- **The bootstrap fails** if a type, a hold reader (section 6) or a standing has no source.

### 5. Who answers, and when the office is open

- **`management_request_topics.owner_role_id`** names a staff role (a resident role is `TOPIC_OWNER_NOT_STAFF`).
  - Residents see `owner { roleKey, roleName }`, never a person.
  - An unassigned request of the topic is told to that role's handlers, or to every handler when it has none.
- **`GET /management-office-hours`** (`requests.create`) returns:
  - the windows and the time zone;
  - whether the office is open now and until when, or when it next opens, by the database's clock (`officeStatus`, unit-tested over touching windows and an empty set).
- The reply time was already the topics' `targetResponseHours`.

### 6. A request to release a hold

- A request on the seeded `release_request` topic is `about` something the author sees that is held now, read through the hold readers the domains register:
  - a ticket on hold (its hold reason);
  - a stopped works permit (the stop's reason);
  - the unit's credit awaiting a refund (`unit_credit`, the one held money there is).
- Anything else is `HELD_ITEM_NOT_FOUND`.
- The reason is kept with the request (`about_reason`). What a request is about never changes (a trigger).
- **One live request per held item** (a partial unique index): `DUPLICATE_RESOURCE` on `about`, also against a racing twin.
- The `about` and the topic go together (`RELEASE_TOPIC_REQUIRED`, or `about` is `FIELD_REQUIRED`). It is refused on a request opened on someone's behalf.

### 7. The unit told of credits and failed payments

- **A credit note** the staff issue tells the unit's finance holders `credit_note.issued` (the reason code, never the amount).
- **A compensation** is a credit note with the new reason `compensation` and why (`creditNoteCompensation`: `service_outage`, `maintenance_delay`, `facility_closure`, `other`).
  - A CHECK keeps it exactly on a compensation.
  - It is told as `compensation.granted`. Credit note views carry `compensationReason`.
- **A checkout's first failed attempt** tells its payer `payment.failed`, while they still see the unit's money.
  - This happens under the checkout's row lock, so a racing callback or a replay tells nothing more.
  - The checkout lists its `alternatives`: `retry` (open, the payer), `new_checkout` (over), `pay_at_office`, `ask_management`.

### 8. Formal notices

- **`formal_notices`** (`FN-` numbers): a decision about a unit kept for good as the compound's record.
  - One per type and subject. Types are a closed list: `late_payment`.
  - Never changed: no UPDATE grant, and a trigger.
- **`formal_notice_recipients`** hold the proofs, each set once by a trigger:
  - **delivered**: the inbox row, at issue;
  - **emailed**: the outbox sets it in the compound's transaction that marks the message sent, through `outbox_messages.formal_notice_recipient_id`. Outbox rows go after 30 days; the proof stays.
  - **read**: the first `GET /me/notices/{id}`.
- The email is critical: sent whatever the preferences. Erasure keeps the notice and its rows, pointing at the tombstone. The export has `notices.json`.
- **The late-payment notice** (sweep `finance.late_notices`):
  - an invoice still owed after its due date and the compound's **cure period** (`finance_settings.late_notice_cure_days`, 0–60, 14 by default; `PATCH /staff/finance/notice-settings`, audited);
  - not disputed, not rescheduled, once;
  - to the unit's finance holders, for what was still owed;
  - under the unit's finance lock, so a payment that commits first leaves nothing to notice.
  - The `invoice.overdue` reminder stays the friendly one.
- `GET /staff/finance/late-notices` (`finance.invoice`) lists them with each recipient's proofs.

### 9. The services a unit is suspended from

- **`GET /me/units/{unitId}/service-standing`** is for whoever has a place on the unit; anyone else gets `UNIT_NOT_FOUND`.
- It lists each service's suspension in force: its reason, its start and end, and `restore` (`wait_until`, `appeal_board` while `appealUntil` has not passed).
- The domains register their standings. Today that is facilities' booking suspension (`no_shows`, the board within 15 days of its start, ADR 0055).

## Lock order (new paths)

| Path | Order |
|---|---|
| Login | the account `FOR NO KEY UPDATE` → the device → the session → the login |
| Device revoke | the same account lock → the device → its sessions |
| Quote | the caller `FOR SHARE` → the ticket `FOR UPDATE` (the start holds the same) |
| Late notice | the unit's finance lock (compound shared, unit) → the notice (unique per subject) → the counter |
| Failed payment | the checkout `FOR UPDATE` |
| Release request | the caller `FOR SHARE` → the hold read (no lock) → the counter → the unique index |

## Privacy

- Audit records ids and codes. A quote's note is recorded as changed only.
- Notification params are codes, plus a quote's amount for the people who decide it.
- The outbox's formal-notice email carries the compound's name, the references, the amount and the day: facts the recipient owns.
- No IP, user agent or place is ever shown or stored for the login history.

## Consequences

- **Migrations** `20261108090000`–`20261108090500`:
  - logins and devices;
  - the inbox archive;
  - quotes;
  - topic owners and release requests (the release topic backfilled);
  - compensation;
  - formal notices.
- **New tenant tables**, each under RLS, forced, with composite keys: `account_logins`, `ticket_quotes`, `formal_notice_counters`, `formal_notices`, `formal_notice_recipients`. Every CHECK is reviewed in the CHECK map.
- **The races are tested:**
  - a login against its device's revoke;
  - a quote's approval against its withdrawal and against the start;
  - two release requests for one hold;
  - two failed callbacks and a replay;
  - a payment against the late-notice sweep.
- **This amends:**
  - **ADR 0027**: archive and delete;
  - **ADR 0036**: devices, logins;
  - **ADR 0032 and 0038**: timeline, quotes;
  - **ADR 0039**: the list in core, topic owners, release requests, office hours for residents;
  - **ADR 0044**: the standing;
  - **ADR 0046 and 0048**: credit notes told, compensation, failed payments, the late-payment notice.
- **The apps' notes** are in [`docs/api/notes/resident-decisions.md`](../api/notes/resident-decisions.md).

## Deviations (noted while building)

1. **The search matches a reference by its integer number**, not by a text prefix: no number column has a text index, and the unique btree serves an exact number.
2. **The caller's permissions are resolved before the lists' transaction.** A first read inside it opened a second transaction (a 500, caught by a fresh compound's test).
3. **The topic's owner is set with `PATCH`** on an existing topic, not at creation.
4. **The service standing route lives in community**, under `/me/units/{unitId}`, since community decides who has a place on a unit.

## Open

- The debtor service suspension: its engine, its never-suspend list and its exemptions.
- A quote that becomes an invoice.
- More formal notice types (a violation warning, a neighbour notice) with a cure period per type.
- The release of a hold acted on by the management: today the request is the ask, and the domain's own staff action lifts it.
