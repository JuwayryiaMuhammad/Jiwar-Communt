# 0050 — Guard shifts and tasks: a roster of gates and zones with lateness, absence and overtime recorded, the handover with a checklist, tasks and the guard's work in one place, swaps decided under one lock order, instructions every guard acknowledges, the gate's lost and found, and a daily report

**Status:** Accepted · Phase G4 · Gate card (the guard's shifts and tasks)

## Context

Since ADR 0028 a guard opens and closes a shift at a gate, and nothing else. The compound could not:
- say who should be where and when;
- see who came late or never came;
- hand a shift over;
- give guards work, or let them trade shifts;
- tell them anything they must read;
- keep what they find;
- read a day of the gate back.

The guard app and the manager dashboard need all of it. What already exists is reused, not rebuilt:
- the shifts and their start hook (ADR 0028, 0035);
- the places (ADR 0047), which become the zones;
- the gate services queue (ADR 0047) and the parking reports (ADR 0045), shown in the guard's work;
- the residents' lost-and-found board (ADR 0042), which stays the neighbours';
- closed mode (ADR 0020), which an inspection needs;
- the CSV writer and the BFF's download path (ADR 0048).

Out of scope:
- patrols and checkpoints (G5);
- payroll: overtime is recorded, never paid from here;
- face recognition at check-in;
- the clinic.

The model follows ADR 0044–0047:
- rules are decided under a lock, by the database's clock;
- rows move forward only, guarded by triggers;
- codes are used instead of free text outside what people write;
- every response is `no-store`;
- every table is under RLS, forced, with composite foreign keys.

## Decisions

### In the gate domain

New folders: `src/gate/roster`, `handover`, `tasks`, `swaps`, `guard-instructions`, `found-items` and `reports`.

Two shared helpers move into `src/core/common`, with no change in behaviour:
- the CSV writer, from finance (which nothing may import);
- the weekly schedule's pure functions, from the community's workers.

`CommunityGatePort` gains `closedSince` (closed mode, as a plain read: the gate never locks a unit's row).

### Posts: gates and zones

A guard works a **post**: a gate, or a zone. Zones are the compound's places (ADR 0047), so the management keeps one list.

- `guard_shifts.gate_id` becomes nullable and `place_id` is added; a CHECK keeps exactly one.
- A shift starts with `gateId` or `zoneId`. The post is read FOR SHARE, so deactivating a gate or retiring a place either waits for the start and ends the new shift, or the start finds it out of service.
- **The gate's actions still need a gate:** `requireOpen` answers 403 `SHIFT_NOT_AT_GATE` for a zone shift (verify, entries, approvals, parcels, plate lookup). Emergencies and gate services take a guard on shift anywhere.
- Retiring a place ends the shifts in it (`place_retired`).
- Shifts start and end by the database's clock.
- An end hook (`onEnded`) runs beside the start hook, for the guard's end and the system's.
- `ShiftView` gains:
  - `zone`, with `gateId` and `gateName` now nullable;
  - the slot's times, `lateMinutes`;
  - `pendingHandovers`.

### The roster

Kept by `guard_roster.manage`:
- **Weekly templates:** a guard, a post, a weekly schedule (overnight windows run into the next day), a first day and an optional last day. What a template says never changes; editing means ending it and making a new one.
- **Single slots:** in the future, a day at most.

How templates become slots:
- A template is made into slots 28 days ahead as it is created, and kept so by an hourly sweep.
- Each slot is made once: a unique index covers cancelled ones too, so the sweep never brings back what the management cancelled.
- Ending a template cancels its slots to come that nobody opened and no swap gave away (`template_ended`).
- A single slot nobody opened is cancelled with a `guardSlotCancel` code.

**No overlap, by one lock.** A guard's slots never overlap one another, nor the slots their templates will make (`ROSTER_OVERLAP` names the clash).
- Every writer takes, in this order, the guard's account row FOR SHARE and then an advisory lock on the guard.
- The account comes first because a deactivation holds it FOR UPDATE before it reaches the roster, and a slot's foreign key needs the row too: the other order could deadlock.
- There is no btree_gist in the repo, and an EXCLUDE constraint would not see the slots still to come.

**Attendance**, recorded only:
- **Opening a shift fills a slot.** The start hook, under the guard's lock, takes FOR UPDATE the guard's earliest unfilled slot at that post whose window takes the start (from 30 minutes before it until its end). It records how many minutes after the start it opened. **Late** is more than 10, and is audited.
- **A shift with no such slot is unscheduled.** At its end it records its length as `unscheduled_minutes`, **never overtime**.
- **Overtime** is only for a shift that filled a slot: the minutes worked beyond the slot's length, recorded at every end.
- **Absent:** a sweep every minute marks, once, a slot nobody opened an hour after its start at a post still in service.
  - It takes the slot with SKIP LOCKED and judges it again under the lock: an opening holding it wins.
  - The roster's keepers are told: `guard_shift.absent_unmanned` (critical) when nobody else is on shift at that post, `guard_shift.absent` (normal) otherwise.
  - A later opening still fills the slot: both facts stay.
  - A post out of service is nobody's absence.
- `GET /staff/security/attendance` and `GET /gate/roster/attendance` add it up per guard with fixed aggregate queries.

Guards read their own schedule (`GET /gate/roster`). The forms pick from `GET /staff/security/posts` and `GET /staff/security/guards`.

### The handover

`POST /gate/shifts/end` takes the checklist and notes:
- **Every active item must be ticked** (422 `HANDOVER_CHECKLIST_INCOMPLETE` names the missing ones). A retired item is ignored, an unknown one refused.
- **Notes are optional**, 2000 characters at most.
- **It is checked and recorded in the end's transaction**, by an end hook, so a refusal ends nothing.
- A handover keeps the items as they read when ticked.
- A shift the system ends leaves a `system` handover with neither checklist nor notes.

**The next guard at that post** sees the handovers of the last day nobody acknowledged (`GET /gate/handovers/pending`, and `pendingHandovers` on the shift).
- They acknowledge one, once, under its row lock (409 `HANDOVER_ALREADY_ACKNOWLEDGED`).
- Never their own (403 `HANDOVER_OWN`); from another post it is not found.
- **Acknowledging never blocks gate work.**

The checklist is the management's (`guard_roster.manage`):
- 30 active items at most, one writer at a time;
- retired, never deleted;
- labels audited as changed.

### Tasks and the guard's work

`guard_tasks.manage` gives guards a task, for one guard, a gate or a zone:
- **a closed unit to inspect:** the unit must be in closed mode (`UNIT_NOT_CLOSED`);
- **a task in the management's own words.**

The guard, or the guards on shift at the post, are told (`guard_task.assigned`).

**A guard on shift takes** an open task of theirs or their post's. The row is taken FOR UPDATE: the first wins (`GUARD_TASK_ALREADY_TAKEN`).

**The guard who took it completes it** with:
- an outcome of its kind (`all_clear` or `issue_found` for an inspection, `done` otherwise);
- a note;
- photos (`guard_task_photo`, five at most; an inspection needs one).

**The unit's primary is told an inspection's outcome** by its code alone (`guard_task.unit_inspected`, normal; no photo, no note, no name). The photos stay staff-only. A guard sees a unit's code and building, never anyone in it.

**Carried over:** at every end, the tasks the guard had (theirs, or taken by them) move to the shift's post, open again. The handover lists them (`carriedTaskIds`).

**`GET /gate/my-work`** shows a guard's work in one place, each kind 50 at most with its total:
- the tasks;
- on shift, the gate services queue and the requests they accepted;
- with `parking_reports.handle`, the open parking reports;
- the instructions waiting for them.

Each is read through its own service and view, and acted on through its own routes.

**The guard role now holds `parking_reports.handle`:** guards close reports, while a fine stays `fines.issue`.
- The permission was offered with G2, and `access:sync` never grants an offered permission again.
- So migration `20261028090000` grants it once to each compound's system guard role, bumping its permissions version so the versioned cache retires the old set.
- A test runs the migration twice inside a rolled-back transaction.
- **A guard sees the reporter by first name.** That's on `/staff/parking-reports` and in the work list, for whoever holds `gate.operate`. The reporter is a resident, and guards see residents by first name (ADR 0031, 0047). The management and the other staff still see the full name. `reporter` becomes `ReporterRefView`, which carries `fullName` or `firstName`.

### Swaps

A guard asks a colleague to take one of their slots: in exchange for one of the colleague's, or as a cover.
1. The colleague accepts or declines.
2. The roster's keepers approve or reject an accepted one, never one of their own.
3. Approval gives the slots their new guards (`swapped_at` moves with the guard).
4. The requester withdraws while it is undecided.

**Race safety comes from one lock order:**
- **A request and an approval** take both guards' locks (accounts FOR SHARE, then roster locks, in id order), then both slots FOR UPDATE in id order, then the swap's row.
- **Answers and withdrawals** take the swap's row alone.
- **A slot is in one live swap at most.** This is decided under the slots' locks (`SWAP_SLOT_BUSY`), with partial unique indexes behind each side.
- **Approval checks everything again** under all of it:
  - both slots scheduled, unopened, to come and still their guards';
  - both guards active `gate.operate` holders;
  - nobody left overlapping (`ROSTER_OVERLAP`).

  Otherwise it answers 409 `SWAP_NOT_POSSIBLE` with the reason, and nothing changes.
- A slot's opening holds its row too: it is filled and kept, or it was given away first.

A sweep every minute expires a live swap whose slot starts before a decision. A slot cancelled cancels its live swaps.

### Instructions to guards

`guard_instructions.manage` sends one to all guards, a gate or a zone:
- urgent ones are a critical push (`guard_instruction.urgent`), the others normal (`guard_instruction.issued`), with generic texts;
- every guard it reaches acknowledges it, once; acknowledging again answers the same.

**Who it reaches** is recorded:
- **At the send:**
  - for all, every active `gate.operate` holder;
  - for a gate or a zone, the guards on shift there and those with a slot there in the next seven days.
- **While it is live:** anyone who opens a shift where it applies. This is a start hook, silent: it shows as pending.
- The send takes the compound's instructions lock exclusively and a start takes it shared. A shift opening while one is sent is therefore seen by the send, or sees it: reached once either way.

Guards list what reaches them, pending or acknowledged, and search the archive. The management reads each with its counts and everyone it reaches, and archives it: it reaches nobody new, and acknowledgements stay.

### The gate's lost and found

`found_items` is a register, not the residents' board.

- **A guard on shift registers** what was found or handed in: what, where (a place and/or words), when, up to three photos (`found_item_photo`). Their shift and post are recorded.
- **The guard records the owner's claim at the gate** while it is held there.
- **The management (`found_items.manage`)** receives an item from the gate, records claims at the office, and may register one there.
- **A claimant is a unit** (by its code) and/or **a name as told.** The name is personal data and goes after 30 days, as a visitor's does (ADR 0028), by a sweep.
- Every write takes the item's row.

The neighbours' board (ADR 0042) is imported by nothing, so the management posts an item there with its own route; the dashboard links to it.

### The daily report

`GET /staff/security/reports/daily` (`guard_reports.read`) covers one of the compound's days, per gate and per zone:
- **the shifts that started then:** guard, times, lateness, overtime or unscheduled minutes;
- **the day's slots:** scheduled, filled, late, absent;
- **the tasks:** made, done, and open at the day's end;
- **the emergencies** reported then and answered from the gate (`responder_gate_id`);
- **the gate services** accepted then, at a lane's gate or by a guard on shift at the gate when they accepted;
- **the visitors** in at the gate (passes and gate requests);
- **the permits' traffic** at the gate (ADR 0049), each with its own count and never inside `visitors`, so `visitors` stays comparable with the days before G3:
  - `contractorWorkers`, `eventGuests` and `moveTrucks`: entries in against a permit (`permit_worker`, `event_guest`, `move_permit`);
  - `materialEntries`: the materials the guards logged in (their own log, not gate entries);
  - `materialExits`: the material exits let out there (a permit used at the gate).

A zone has none of these gate counts: they are null for it.

Every gate is listed, zones only where something happened. It uses fixed aggregate queries, never one per post, with a new `(tenant, gate, occurred_at)` index on the gate entries.

`…/export` is the same as CSV through ADR 0048's writer, one row per post, its name in Content-Disposition for the BFF's download path. The permits' counts are its last five columns: `contractor_workers`, `event_guests`, `move_trucks`, `material_entries`, `material_exits`, empty for a zone.

### Permissions and roles

| Permission | Who holds it |
|---|---|
| `guard_roster.manage` | staff or manager; the manager role and the security supervisor. Roster, attendance, swap decisions, the handover checklist and handovers |
| `guard_tasks.manage` | staff or manager; the manager role and the security supervisor |
| `guard_instructions.manage` | staff or manager; the manager role and the security supervisor |
| `guard_reports.read` | staff or manager; the manager role and the security supervisor |
| `found_items.manage` | staff or manager; the manager role only |
| `parking_reports.handle` | now also the guard role (above) |

- A new default staff role, `security_supervisor`, holds the first four. It is not a guard: a compound adds `gate.operate` to it for one who also works a gate.
- `pnpm access:sync` brings the rest to existing compounds.

### Notifications

A new delivery category, `guard_duty`. Params are codes at most: never a name, a unit or a post's name.

| Kind | To | Critical |
|---|---|---|
| `guard_shift.absent` | the roster's keepers | no |
| `guard_shift.absent_unmanned` | the roster's keepers (nobody on shift there) | yes |
| `guard_task.assigned` | the guard, or the guards on shift at the post | no |
| `guard_task.unit_inspected` | the unit's primary (category `household`) | no |
| `guard_swap.requested` · `declined` · `approved` · `rejected` · `expired` · `cancelled` | the guards concerned | no |
| `guard_swap.accepted` | the roster's keepers | no |
| `guard_instruction.issued` | the guards it reaches | no |
| `guard_instruction.urgent` | the guards it reaches | yes |

### Privacy and audit

- **Audit:** ids, codes and counts only. Free text never enters; a label goes in as changed.
- **Deactivated** (an erasure deactivates first), in that transaction, after their open shift ended and moved their tasks to its post:
  - their live swaps are cancelled (`guard_left`);
  - their live templates end;
  - their slots to come are cancelled (`guard_left`);
  - the tasks still theirs are cancelled (`assignee_left`).

  Their shifts, handovers and attendance stay: they are the compound's record.
- **Erased:** what they wrote goes, once each and audited: handover notes, task result notes, swap reasons. A found item's description and a task's photos stay, because they describe an object or a unit, not the guard.
- **Export** (`guard-duty/`): their shifts, slots, swaps (the reason when they asked), handovers, the tasks they took, the instructions that reached them, and the items they registered. Posts are given by name, never another guard's name or words.
- **Who sees whom:** guards see each other by first name, the management by full name.

## Consequences

- **Migrations** (`20261028090000` to `20261028091100`):
  - the guard's parking reports;
  - the zone on shifts;
  - the `guard_duty` category alone;
  - the roster (with the shift trigger);
  - the handover;
  - the two photo purposes alone, then both file CHECKs recreated with every purpose, G3's `contractor_photo` and `permit_photo` (ADR 0049, recreated before in `20261027090100`) included, and a schema test that inserts a file of every purpose the database knows;
  - tasks;
  - swaps;
  - instructions;
  - found items;
  - the gate entries' day index.
- **Eleven new tenant tables**, each under RLS, forced, with composite keys. Every CHECK is reviewed in the CHECK map. Nothing is deleted by the app; triggers guard every row, and `guard_shifts` now moves forward only too.
- **This amends ADR 0028:**
  - a shift is at a gate or in a zone;
  - ending it takes the handover;
  - it is linked to the roster.
- **This amends ADR 0036:**
  - a fourteenth delivery category, after G3's `permits`;
  - a `guard-duty` export section;
  - two more critical kinds.
- **This amends ADR 0045:**
  - the guard role closes parking reports;
  - a `gate.operate` holder sees the reporter by first name.
- **The manager dashboard** gains a Security group:
  - roster, shift swaps, handovers, guard tasks, instructions, found at the gate, and the daily report;
  - `parking_reports.handle` no longer admits to it.

## Open

- **No overdue alarm on a task:** the work list sorts by due time, and nobody is pushed when one passes.
- **A handover nobody acknowledges** tells nobody; the daily report and the handovers page show it.
- **The roster is made 28 days ahead.** A template edited means ended and made again; slots already swapped stay.
- **A gate service accepted by a guard in a zone** counts at no gate in the daily report.
- **No payroll**, and no export of attendance as CSV yet.
