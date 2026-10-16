# 0049 — Permits and contractors: one table of what a unit asks the management for, contractors checked by face and the last four of their ID, the compound's work hours at every entry, goods out once, guest lists at the gate, and people's data gone 30 days on

**Status:** Accepted · Phase G3 · Gate card (permits)

## Context

A compound lets things happen in a unit that the gate has to know about:
- **works** by a contractor's workers (renovation, finishing);
- **furniture moved** in or out by a truck;
- **materials** brought in, and taken out;
- **private events**, with guests at the gate.

Until now the guard had nothing to check them against, and the management no record of who was let in to work.

Out of scope: full move-in and move-out with contracts (R8), and paying for permits.

The model follows ADR 0044, 0045 and 0047:
- rules are checked under a lock, by the database's clock;
- rows move forward only, guarded by triggers;
- codes are used instead of free text outside what people write;
- every response is `no-store`;
- every table is under RLS, forced, with composite foreign keys.

## Decisions

### In the gate domain

`src/gate/permits`, reading the community through `CommunityGatePort`: who lives in a unit, its primary, its capabilities and codes. It reuses:
- the gate log and its entries;
- the plate key and the plate lookup;
- the shift;
- the account lock, the notifications and the guards on shift (`SafetyCore`);
- the files' claim and attach;
- the sweep runner.

### The compound's work rules

`permit_settings`, one row per compound (provisioned, and backfilled by the migration). It holds:
- the **work days** (0 = Sunday … 6 = Saturday);
- the **hours**, from before to, never overnight;
- up to 100 **dated days off** (feasts).

The default is Saturday to Thursday, 09:00–17:00, no days off.

- The management changes them (`permits.manage`, `PATCH /staff/permit-settings`), audited by value.
- Residents and guards read them with the time zone and the fixed limits (`GET /community/permit-rules`).
- A request reads the row `FOR SHARE`, so a change waits for it.
- **The guard applies the rules as they stand at each entry**: a narrower window refuses the next entry, never one already recorded.

### One table, `unit_permits`, with a kind

What each kind carries is held by a CHECK.

| Kind | Who asks | What it carries | Live per unit |
|---|---|---|---|
| `works` (W-) | the unit's primary | renovation or finishing; a period of local days (from today, at most 90 days ahead, at most 180 long, holding a work day); daily hours inside the compound's; the contractor company; a description | 3 |
| `move` (M-) | the unit's primary | one work day that is not a day off; a window inside the hours; the truck's plate; the items | 2 |
| `material_exit` (X-) | the unit's primary | 1–30 item lines; an optional photo (`permit_photo`); valid from a local day for up to seven days | 5 |
| `event` (E-) | anyone the unit lets invite visitors | a window of up to 24 hours (overnight is fine), starting within 90 days; a title; the guest list (names, optional plates) | 3 upcoming |

- **Limits** are checked under the unit's advisory lock (`permit-unit`), never the unit's row.
- **Numbers** come from `permit_counters`, last in the transaction.

**Statuses**
- `pending` → `approved` | `rejected` | `cancelled`.
- `approved` → `cancelled` | `revoked` | `used`; `used` applies to a material exit only.
- Views add `ended` for an approved permit whose window has passed.
- A trigger keeps what a permit asks, moves it forward only, and records each decision, revocation, use and cancellation once. Nothing is ever deleted.

**Events**
- **Up to 20 guests:** approved at once (decision `auto`), and nobody is told. The event may hold 20.
- **21 to 150:** pending, for the management, and may hold as many as were listed.
- **More than 150:** refused.
- The host or the primary adds guests until the start (`PERMIT_STARTED`), never past the limit (a bigger event is a new request), and takes guests off while the event is open. All of this happens under the event's row lock.

**Contractor workers** (`permit_workers`, works only)
- Each worker has a name, a face (`contractor_photo`) and the type of their ID.
- **The last four of the ID number are never stored.** They are kept as a keyed hash: HMAC with the server's pepper, bound to the compound and the worker. Nobody sees them again.
- Workers are added one by one while the permit is pending or approved and not ended, with no new approval. At most 30 per permit; removed ones do not count.
- The requester or the primary takes a worker off. The management can too, with a reason code.
- **Never stored:** the whole ID number, or a scan of it.
- **`@Idempotent` gains `omit`:** the stored request hash leaves the last four out, so the database cannot tell them either.

A guest (`permit_guests`) and a worker each point at a permit of their own kind, through a composite key on `(tenant, id, kind)`.

**Pending permits nobody decided** are cancelled by the system (`not_decided`, the `permits.not_decided` sweep):
- works, a move or a material exit, once its window has ended;
- an event, once it has started.

The requester is told.

### The management decides

`permits.manage` (`/staff/unit-permits`) has:
- the queue, and what is in force now;
- one permit, with the workers' faces, the guests, the goods and its photo, and the staff's notes;
- the decisions:
  - **approve** a pending permit, not once its window has passed, with an optional note of its own;
  - **reject** with a code from `unitPermitReject`;
  - **revoke** an approved permit in force (`unitPermitRevoke`);
  - **take a worker off** (`permitWorkerRemove`).

Each decision runs under the permit's row lock, so a decision and the requester's cancellation never both win. The requester is told the kind and the code, never the note. The household's view never carries the staff's notes.

### At the gate

**"Verify" for a permit is a lookup.** Contractors and guests carry no code (this differs from the wording of the request).
- `GET /gate/unit-permits?unitCode=|reference=` lists the approved permits in force today. A reference can be written `W-42`, `w42` or `W-0042`.
- `GET /gate/unit-permits/{id}` opens one:
  - the workers' faces, and whether each is inside;
  - the truck and its items;
  - the goods and their photo;
  - **the guest list, from half an hour before the event to its end**;
  - the hours works or a move may go on today.

  It is open for a permit in force today, or one with someone of it inside.
- Both need an open shift and are rate-limited like the code check. They are audited on the shift (`gate.permit_lookup`), with ids only.
- **The guard sees guests' names.** ADR 0028 says the guard never sees a visitor's name. A guest list is the exception: checking names is what the guard is there for. The names are shown only while the event is on.

**Entries** go through `POST /gate/entries`.
- Three subject types are added: `permit_worker` (the worker's id), `event_guest` (the guest's id) and `move_permit` (the permit's id).
- They are let in with a new method, `permit`. The enum values sit alone in one migration, and the direction CHECK is recreated in the next.

**When a permit's `in` is refused**
- **`not_approved`, `cancelled`, `revoked`, `used`:** the permit's status forbids it.
- **`not_yet_valid` and `expired`:** the time is outside the permit's window. Guests may come 30 minutes early.
- **`worker_removed` and `guest_removed`:** the person was taken off the permit.
- **`day_off` and `outside_work_hours`:** the compound's rules at that instant forbid it. This applies to works and moves; a worker is also held to the permit's own daily hours.

Exits are always recorded. The inside list names the permit, never a person.

**The ID check**
- A worker's `in` carries the last four the guard types after matching the face. They are required, offline too.
- The server compares the keyed hashes in constant time. A mismatch is refused (`id_mismatch`) and counted in Redis, which survives the transaction's rollback.
- **Lockouts:**
  - five mismatches in 15 minutes lock the guard out;
  - ten in a day lock the worker out, at every gate.

  Both give `PERMIT_ID_LOCKED` with `params.scope`. They are checked after the shift and before anything else.
- **The management lifts a lockout** from a works permit's detail. The detail lists the permit's workers who are locked out, and the compound's guards who are. A typing error must not cost a contractor a working day. The unlock is audited by ids (`unit_permit.lockout_cleared`).

**Materials**
- **In:** no permit is needed. The guard logs what came, for which unit, and its works permit when there is one (`material_entries`). The log is append-only like the gate log, with no foreign keys, in the guard's words.
- **Out:** the guard checks an approved material exit and marks it used, once, under its row lock (`POST /gate/unit-permits/{id}/use`). It is refused like an entry. The requester is told.

**The plate lookup** (ADR 0045) also finds an approved move's truck and the car of a guest still on an approved event's list, within a day of now. Each match says what to record against and whether it may come in, never a name.

**Every subject type locks its own row** in the entries:
- the pass, the engagement and the approval request, explicitly;
- a worker or a guest: their permit `FOR SHARE`, then their own row;
- a move: the permit.

An unknown type is a programming error, never another table's lock.

### Permissions and roles

| Permission | Who holds it |
|---|---|
| `permits.request` | residents and family (the services decide per unit and kind) |
| `permits.manage` | staff or manager; the manager role |

- The guard role is unchanged: `gate.operate` inside a shift is enough.
- `pnpm access:sync` brings existing compounds the grants.
- The dashboard admits a staff role that holds only `permits.manage`.

### Notifications

There is a new category, `permits`. None of its kinds is critical. Params are the permit's kind and a reason's code at most: never a name, a unit or a plate.

| Kind | Who is told |
|---|---|
| `unit_permit.requested` | the `permits.manage` holders (never for an event approved at once) |
| `unit_permit.approved` | the requester |
| `unit_permit.rejected` | the requester, with the code |
| `unit_permit.revoked` | the requester, with the code |
| `unit_permit.cancelled` | the requester (not decided in time), or the primary (the requester left) |
| `unit_permit.used` | the requester, when the goods went out |

Each has its English and Arabic push text, generic. The household is not pushed when a contractor comes in or goes out: the gate log has it.

### Privacy and audit

**Audit rows** carry ids, kinds, statuses, codes, dates and counts.
- A description, a company, a title or the items appear only as booleans.
- Never a name, a plate, a staff note's words, a guard's words or the last four (not even hashed).

**The purge** (`permits.people_data`) runs 30 days after a permit ended, or was rejected, cancelled, revoked or used.
- It clears the workers' names, faces and ID hashes, the guests' names and plates, the truck's plate and the goods' photo, at once (`purged_at`).
- It works one permit per transaction: the permit's row is locked, then its workers' and guests' rows, as the gate locks them.
- The gate log keeps its ids, so an exit still resolves. The purge is audited by counts.

**A requester who goes**
- **Their live permits are cancelled by the system** (`requester_left`), and the primary is told, when the requester:
  - loses their place in the unit;
  - for an event, may no longer invite visitors;
  - is deactivated or erased.
- **Losing only the primary role keeps them.** The work is the unit's, and the new primary may cancel it.

**Erased:** what the resident wrote and their goods' photo go once, together (`text_cleared_at`, audited with booleans). The management's notes and the materials log stay.

**Export** (`permits/permits.json`):
- **Included:** the account's own permits, with what it wrote and its workers' and guests' names while they last.
- **Never included:** the last four, a face or a photo (the permit's files, not the account's: ADR 0036), the staff's notes, or who decided.

## Consequences

**Migrations** (`20261027090000` to `20261027090600`):
- `090000`: the enum values alone (the `permits` category, `contractor_photo` and `permit_photo`);
- `090100`: both file CHECKs, recreated whole;
- `090200`: the permit rules (backfilled);
- `090300`: the permits, workers, guests and counters;
- `090400`: the gate's subject types and method;
- `090500`: the entries' direction CHECK;
- `090600`: the materials log.

A branch merged after this one recreates the file CHECKs again with its purposes and these, and re-stamps its migrations to sort after these.

**Six new tenant tables**, each under RLS, forced. Every new CHECK is reviewed in the CHECK map. Nothing here is deleted by the app; triggers guard every row.

**This amends ADR 0028:**
- the guard reads an event's guest list while it is on;
- the gate log knows three more subjects and the `permit` method;
- every subject type locks its own row.

**This amends ADR 0036:** a thirteenth delivery category, `permits`, and a `permits` export section.

**This amends ADR 0045:** the plate lookup finds moves' trucks and guests' cars.

**`RateLimitService` gains `reset`**, for an unlock.

**The manager dashboard gains:**
- Permits (the queue, in force now, one permit with its decisions and unlocks);
- Materials log;
- Work hours.

## Open

- **No live channel.** The dashboard and the apps poll; pushes tell.
- **A worker who forgets their ID** cannot come in: the guard calls the household, which asks the management. There is no override at the gate by design.
- **Workers added after approval** need no new approval. The management sees them and may take any off.
- **Move-in and move-out with contracts** (R8) is not built. A move permit carries no direction.
