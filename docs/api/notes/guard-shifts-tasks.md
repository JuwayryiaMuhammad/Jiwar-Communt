# Guard shifts and tasks: backend notes for the guard app

What was built for the guard's shifts and their work:
- the shift at a gate or in a zone, and the schedule;
- the handover;
- tasks and "my work";
- swaps, instructions to acknowledge;
- the gate's lost and found.

The management's side (roster, decisions, the daily report) is in the manager dashboard.
- The design decisions are in [ADR 0050](../../decisions/0050-guard-shifts-and-tasks.md).
- The contract is `docs/api/openapi.v0.json` (regenerated) and the Postman collection.

What a guard records at the gate feeds the daily report, each kind counted on its own line:
- visitors (passes and gate requests);
- with permits (ADR 0049): contractor workers, event guests and move trucks let in, the materials logged in, and the material exits let out.

A permit's entry never counts as a visitor.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`. Every route here needs `gate.operate` (the guard role).
- Lists are `{ "data": [...], "nextCursor": string | null }`; pass `nextCursor` back as `?cursor=`.
- Errors are `{ "statusCode", "code", "message", "params"?, "fields"?: [{ "field", "code", "params"? }], "requestId", ... }`. Switch on `code` and `fields[].code`, never on `message`.
- Creates take an optional `Idempotency-Key` header (a UUID): a retry with the same key answers the same, once.
- **Every new response is `Cache-Control: no-store`.** Do not cache them on the device.
- Instants are ISO 8601 UTC. "Days" (`YYYY-MM-DD`) are the compound's.
- Colleagues appear by first name (`{ id, firstName }`, or `{ id, erased: true }`), never a phone.

## Contents

1. [The shift: a gate or a zone](#the-shift-a-gate-or-a-zone)
2. [My schedule and attendance](#my-schedule-and-attendance)
3. [Ending a shift: the handover](#ending-a-shift-the-handover)
4. [Taking over: acknowledging a handover](#taking-over-acknowledging-a-handover)
5. [My work](#my-work)
6. [Tasks](#tasks)
7. [Swaps](#swaps)
8. [Instructions](#instructions)
9. [Lost and found](#lost-and-found)
10. [Push notifications](#push-notifications)
11. [Value lists](#value-lists)
12. [Errors](#errors)
13. [What changed for the existing shift routes](#what-changed-for-the-existing-shift-routes)
14. [Not built](#not-built)

---

## The shift: a gate or a zone

A guard works a **post**: a gate, or a zone. Zones are the compound's places: `GET /community/places`, as for gate services.

### POST /gate/shifts/start → 201 `ShiftView`

```json
{ "gateId": "…" }
```
or
```json
{ "zoneId": "…" }
```

- Exactly one, or `VALIDATION_FAILED`: `gateId` `FIELD_REQUIRED` when neither is given, `zoneId` `FIELD_NOT_ALLOWED` when both are.
- A gate not in service: 404 `GATE_NOT_FOUND`. A zone not in service: 404 `PLACE_NOT_FOUND`.
- Already on shift: 409 `SHIFT_ALREADY_OPEN`.
- **In a zone, the gate's own actions answer 403 `SHIFT_NOT_AT_GATE`:** verify, entries, "who is inside", approval requests, parcels, plate lookup. Emergencies, gate services, tasks and the rest work anywhere.
- The shift fills your slot at that post when one starts within 30 minutes or is under way. More than 10 minutes after its start is late, and the management sees it.

`ShiftView`:

| Field | Meaning |
|---|---|
| `id`, `startedAt`, `endedAt` | As before. |
| `gateId`, `gateName` | **Now nullable:** null for a zone shift. |
| `zone` | `{ id, key, nameEn, nameAr }` for a zone shift, else null. |
| `scheduledStart`, `scheduledEnd` | The slot it filled; null for an unscheduled shift. |
| `lateMinutes` | Minutes after the slot's start it opened (0 if early); null when unscheduled. More than 10 is late. |
| `pendingHandovers` | While open: handovers at this post waiting to be acknowledged. Show a banner. |

`GET /gate/shifts/current` answers the shift wherever it is, or 403 `NO_OPEN_SHIFT`.

A gate deactivated or a zone retired ends the shift (as before, no push): the next call answers `NO_OPEN_SHIFT`.

---

## My schedule and attendance

### GET /gate/roster?from=&to= → 200 `{ data: MySlotView[] }`

The compound's days `from` … `to` (default today and the 13 after), 31 at most (`PERIOD_TOO_LONG`).

| Field | Meaning |
|---|---|
| `post` | `{ gateId, gateName, zone }`. |
| `startsAt`, `endsAt` | A slot may run past midnight. |
| `status` | `scheduled` or `cancelled` (`cancelReason`). |
| `shift` | The shift that filled it, or null. |
| `lateMinutes`, `late` | |
| `absentAt` | Not opened an hour after its start. |
| `swappedAt` | A swap gave it to you. |

### GET /gate/roster/attendance?from=&to= → 200 `GuardAttendanceView`

Over the period:
- `slots`, `filled`, `late`, `absent`;
- `scheduledMinutes`, `workedMinutes`, `overtimeMinutes`;
- `unscheduledShifts`, `unscheduledMinutes`.

These are recorded only: no payroll. Overtime is only for shifts that filled a slot; an unscheduled shift is never overtime.

---

## Ending a shift: the handover

### GET /gate/handover-items → 200 `{ data: [{ id, label, position }] }`

The compound's checklist. **Every item here must be ticked to end.** The list may be empty.

### POST /gate/shifts/end → 200 `ShiftView`

```json
{ "checklist": ["<item id>", "…"], "notes": "The barrier sticks; push twice." }
```

- `checklist`: the ids of the items ticked. **All active ones**, or 422 `HANDOVER_CHECKLIST_INCOMPLETE` with `params.missing` (the ids).
  - Refetch the list and ask again: an item may have been added while the guard filled it in.
  - An unknown id is `VALIDATION_FAILED` (`checklist`, `INVALID_VALUE`).
- `notes`: optional, 2000 characters at most. The next guard and the management read them.
- A refusal ends nothing: the shift stays open.
- The tasks you had move to your post for the next guard (see [Tasks](#tasks)).
- `Idempotency-Key` as before.

---

## Taking over: acknowledging a handover

### GET /gate/handovers/pending → 200 `{ data: GuardHandoverView[] }`

On shift: the handovers of the last day at your post nobody acknowledged, newest first, never your own.

| Field | Meaning |
|---|---|
| `guard` | Who handed over: `{ id, firstName }`. |
| `kind` | `guard`, or `system` when the system ended the shift (post out of service, guard gone): no checklist, no notes. |
| `checklist` | `[{ itemId, label }]`, as ticked. |
| `notes` | Or null. |
| `carriedTaskIds` | Tasks the end moved to this post: open them with `GET /gate/tasks/{id}`. |
| `acknowledgedAt`, `acknowledgedBy` | Null until someone acknowledges it. |

### POST /gate/handovers/{id}/acknowledge → 200

- Once: of two guards, the first wins (409 `HANDOVER_ALREADY_ACKNOWLEDGED`).
- Never your own (403 `HANDOVER_OWN`).
- From another post it is not found (404 `HANDOVER_NOT_FOUND`).

**It blocks nothing:** gate work goes on without it.

---

## My work

### GET /gate/my-work → 200 `MyWorkView`

One screen for everything, each kind 50 at most with `total`:

| Field | What |
|---|---|
| `onShift` | |
| `pendingInstructions` | How many instructions wait for your acknowledgement: a banner until 0. |
| `tasks` | Yours, your post's (while on shift there) and those you took, open or in progress, **due first**. Act through `/gate/tasks/{id}`. |
| `gateServiceQueue` | On shift: the open gate service requests, oldest first. Null off shift. Act through `/gate/gate-services/{id}` (ADR 0047). |
| `myGateServices` | On shift: the requests you accepted, not closed. |
| `parkingReports` | The open wrong-parking reports. **The guard role now closes them** (`POST /staff/parking-reports/{id}/close`); turning one into a fine is not the guard's (403). The reporter comes by **first name** (`reporter.firstName`), here and on `/staff/parking-reports`. |

---

## Tasks

The management gives tasks to one guard, a gate or a zone:
- **`closed_unit_inspection`**: a unit whose household turned closed mode on. `title` is null: name it yourself ("Inspect unit B7"). `unit` is `{ unitId, unitCode, building }`, never anyone in it.
- **`custom`**: the management's `title` and `details`.

| Route | |
|---|---|
| `GET /gate/tasks/{id}` | Yours, your post's while on shift there, or one you took; else 404 `GUARD_TASK_NOT_FOUND`. |
| `POST /gate/tasks/{id}/take` | On shift (403 `NO_OPEN_SHIFT`), an open task: the first wins (409 `GUARD_TASK_ALREADY_TAKEN`). |
| `POST /gate/tasks/{id}/complete` | The one who took it (403 `GUARD_TASK_NOT_TAKER`), while in progress (409 `GUARD_TASK_CLOSED`). |

The body of `POST /gate/tasks/{id}/complete`:

```json
{ "outcome": "issue_found", "note": "A window is open", "photoFileIds": ["…"] }
```

- `outcome`: `all_clear` or `issue_found` for an inspection, `done` for a custom task (`INVALID_VALUE` with `params.allowed`).
- `photoFileIds`: finalized files of purpose `guard_task_photo` (images, 5 MB; `POST /files` then finalize). At most 5; **an inspection needs one** (`FIELD_REQUIRED`).
- The unit's primary is told an inspection's outcome by its code only, never the photos or the note.

When a shift ends, its guard's open tasks (theirs, or taken by them) **move to that post, open again** (`carried: true`), for the next guard there.

---

## Swaps

Ask a colleague to take one of your slots: **in exchange** for one of theirs (`colleagueSlotId`), or **as a cover** (none).
1. The colleague accepts or declines.
2. The management approves or rejects.
3. You may withdraw while it is undecided.

### POST /gate/swaps → 201 `GuardSwapView`

```json
{ "slotId": "…", "colleagueId": "…", "colleagueSlotId": "…", "reason": "A family wedding" }
```

- `slotId`: yours, scheduled, unopened, to come; else `SLOT_NOT_SWAPPABLE`. The same check applies to `colleagueSlotId` for the colleague.
- `colleagueId`: an active guard, not you (`GUARD_NOT_ELIGIBLE`).
- A slot is in one live swap at most (409 `SWAP_SLOT_BUSY`).
- Nobody may be left with overlapping shifts (409 `ROSTER_OVERLAP`, `params.startsAt`, `params.endsAt`).
- `reason`: optional, 500 characters; the colleague and the management read it.

| Route | |
|---|---|
| `GET /gate/swaps` | Yours, either side, newest first. `role` is `requester` or `colleague`. |
| `GET /gate/swaps/{id}` | |
| `POST /gate/swaps/{id}/accept` | The colleague (403 `SWAP_ACTION_NOT_ALLOWED` otherwise), while `requested` (409 `SWAP_CLOSED`). |
| `POST /gate/swaps/{id}/decline` | Same. |
| `POST /gate/swaps/{id}/withdraw` | The requester, while `requested` or `accepted`. |

How a swap ends:
- **Approved:** the slots have their new guards; check `GET /gate/roster`.
- **Expired:** a slot started before the management decided.
- **Cancelled by the system** (`closeReason`): `slot_cancelled`, `slot_changed` or `guard_left`.

---

## Instructions

The management sends instructions to all guards, to a gate, or to a zone. **Each must be acknowledged.**
- An urgent one is a critical push; the others are normal pushes.
- One applying where you open a shift reaches you then, with no push: it shows as pending.

| Route | |
|---|---|
| `GET /gate/guard-instructions?status=pending\|acknowledged&q=` | Those that reach you, newest first. `q` searches the title and text (the archive). |
| `GET /gate/guard-instructions/{id}` | 404 `GUARD_INSTRUCTION_NOT_FOUND` for one that does not reach you. |
| `POST /gate/guard-instructions/{id}/acknowledge` | Once; again answers the same. |

`MyGuardInstructionView` fields:
- `title`, `body`, `urgent`;
- `audience` (`all`, `gate`, `zone`) with `post`;
- `createdAt`;
- `archivedAt` (the management archived it: it stays readable);
- `acknowledgedAt` (yours).

---

## Lost and found

The gate's register: what security finds or is handed. (The residents' board is the neighbours' lost and found: not this.)

### POST /gate/found-items → 201 `FoundItemView`

On shift (403 `NO_OPEN_SHIFT`); your shift and post are recorded.

```json
{ "description": "A black wallet", "placeId": "…", "location": "By the pool", "foundAt": "…", "photoFileIds": ["…"] }
```

- `description` (1–500) is required.
- `placeId`: a place in service, optional.
- `location`: words, optional.
- `foundAt`: default now, never later.
- `photoFileIds`: purpose `found_item_photo`, 3 at most.

| Route | |
|---|---|
| `GET /gate/found-items?status=at_gate\|with_management\|claimed` | The register, newest first. |
| `GET /gate/found-items/{id}` | |
| `POST /gate/found-items/{id}/claim` | The owner collects it at the gate while it is held there (`at_gate`). Once the management has it: 409 `FOUND_ITEM_CLOSED`. |

The body of `POST /gate/found-items/{id}/claim`:

```json
{ "unitCode": "B7", "name": "Alice", "note": "Showed an ID" }
```

- A unit and/or a name, one at least (`name` `FIELD_REQUIRED`).
- An unknown unit is `UNIT_CODE_UNKNOWN`.
- The name is kept 30 days, then cleared.

---

## Push notifications

Category `guard_duty`, generic texts, never a name or a post:

| Kind | When | Critical |
|---|---|---|
| `guard_task.assigned` | a task for you, or your post while on shift there (`params.taskKind`) | no |
| `guard_swap.requested` | a colleague asks you | no |
| `guard_swap.declined` | your colleague declined | no |
| `guard_swap.approved` · `rejected` · `expired` · `cancelled` | your swap was decided or ended | no |
| `guard_instruction.issued` | an instruction to acknowledge | no |
| `guard_instruction.urgent` | an urgent one | **yes** |

Targets: `guard_task`, `guard_shift_swap`, `guard_instruction` (the id to open).

---

## Value lists

- `GuardTaskKind`: `closed_unit_inspection`, `custom`.
- `GuardTaskStatus`: `open`, `in_progress`, `done`, `cancelled`.
- `guardTaskOutcome`: `all_clear`, `issue_found` (inspection), `done` (custom).
- `GuardSwapStatus`: `requested`, `accepted`, `approved`, `declined`, `rejected`, `withdrawn`, `cancelled`, `expired`.
- `guardSwapCancel` (the system's): `slot_cancelled`, `slot_changed`, `guard_left`.
- `FoundItemStatus`: `at_gate`, `with_management`, `claimed`.
- `GuardHandoverKind`: `guard`, `system`.

---

## Errors

| Code | Status | When |
|---|---|---|
| `SHIFT_NOT_AT_GATE` | 403 | A gate action during a zone shift. |
| `HANDOVER_CHECKLIST_INCOMPLETE` | 422 | Ending without every active item; `params.missing`. |
| `HANDOVER_ALREADY_ACKNOWLEDGED` | 409 | Someone acknowledged it first. |
| `HANDOVER_OWN` | 403 | Your own handover. |
| `HANDOVER_NOT_FOUND` | 404 | Not at your post. |
| `GUARD_TASK_NOT_FOUND` | 404 | Not yours, not your post's. |
| `GUARD_TASK_ALREADY_TAKEN` | 409 | Another guard took it. |
| `GUARD_TASK_NOT_TAKER` | 403 | Only the one who took it completes it. |
| `GUARD_TASK_CLOSED` | 409 | Done, cancelled, or not taken yet; `params.status`. |
| `SWAP_NOT_FOUND` | 404 | |
| `SWAP_SLOT_BUSY` | 409 | A slot is in another swap. |
| `SWAP_CLOSED` | 409 | Not at that step; `params.status`. |
| `SWAP_ACTION_NOT_ALLOWED` | 403 | Not your side of it. |
| `ROSTER_OVERLAP` | 409 | Someone would be in two places at once. |
| `GUARD_INSTRUCTION_NOT_FOUND` | 404 | It does not reach you. |
| `FOUND_ITEM_NOT_FOUND` | 404 | |
| `FOUND_ITEM_CLOSED` | 409 | Not at the gate any more; `params.status`. |
| Field codes | 400 | `SLOT_NOT_SWAPPABLE`, `GUARD_NOT_ELIGIBLE`, `UNIT_CODE_UNKNOWN`, `PERIOD_TOO_LONG`, `FILE_NOT_AVAILABLE`. |

---

## What changed for the existing shift routes

- `POST /gate/shifts/start` takes `zoneId` as well as `gateId`.
- `ShiftView.gateId` and `gateName` are **nullable**. It gains:
  - `zone`;
  - `scheduledStart`, `scheduledEnd`, `lateMinutes`;
  - `pendingHandovers`.
- `POST /gate/shifts/end` takes a body (`checklist`, `notes`). An empty body still works while the compound has no checklist.

---

## Not built

- Face recognition at check-in, and the supervisor's manual check-in code.
- A guard picking who takes over: the next guard at the post acknowledges.
- "Extended" shifts when nobody takes over: the shift simply stays open.
- Patrols and checkpoints (G5).
- Voice read-out of instructions; seasonal instructions (archive and send again).
- An overdue alarm on a task.
