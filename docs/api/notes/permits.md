# Permits and contractors: backend notes for the mobile team

What was built for a unit's permits, and the guard's side of them:
- works by a contractor, with its workers;
- furniture moves;
- taking materials out (bringing them in needs no permit);
- private events with a guest list.

The design decisions are in [ADR 0049](../../decisions/0049-permits-and-contractors.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`.
- Lists are `{ "data": [...], "nextCursor": string | null }`; pass `nextCursor` back as `?cursor=`.
- Errors are `{ "statusCode", "code", "message", "params"?, "fields"?: [{ "field", "code", "params"? }], "requestId", ... }`. Switch on `code` and `fields[].code`, never on `message`.
- Creates take an optional `Idempotency-Key` header (a UUID): a retry with the same key answers the same, once.
- **Every response here is `Cache-Control: no-store`.** They carry names, plates and presigned photo URLs. Do not cache them on the device.
- Instants are ISO 8601 UTC. Times of day (`HH:mm`) and local days (`YYYY-MM-DD`) are in the **compound's** time zone (`timeZone` in the rules).

## Contents

1. [The compound's rules](#the-compounds-rules)
2. [Works by a contractor](#works-by-a-contractor)
3. [Contractor workers](#contractor-workers)
4. [Furniture moves](#furniture-moves)
5. [Taking materials out](#taking-materials-out)
6. [Private events and their guests](#private-events-and-their-guests)
7. [The unit's permits, one permit, cancelling](#the-units-permits-one-permit-cancelling)
8. [The permit view](#the-permit-view)
9. [The guard](#the-guard)
10. [Push notifications](#push-notifications)
11. [Value lists](#value-lists)
12. [Errors](#errors)
13. [Where we differ from the request](#where-we-differ-from-the-request)
14. [Not built](#not-built)

---

## The compound's rules

### `GET /community/permit-rules` → `200`

**Who:** residents and family (and the management, the guards). Read it before showing a works or move form: what the resident picks must fit.

```json
{
  "workDays": [0, 1, 2, 3, 4, 6],
  "workHours": { "from": "09:00", "to": "17:00" },
  "daysOff": ["2026-11-20"],
  "timeZone": "Africa/Cairo",
  "limits": {
    "liveWorks": 3, "liveMoves": 2, "liveMaterialExits": 5, "upcomingEvents": 3,
    "workersPerPermit": 30, "eventGuestsWithoutApproval": 20, "eventGuestsMax": 150,
    "worksMaxDays": 180, "materialExitMaxDays": 7, "eventMaxHours": 24,
    "maxDaysAhead": 90, "daysOff": 100
  }
}
```

- `workDays`: 0 = Sunday … 6 = Saturday.
- `daysOff`: from today on.
- The management may change the rules at any time. The guard applies them **as they stand at each entry**, so an approved permit's worker may be refused on a day the compound has since made a day off.

---

## Works by a contractor

### `POST /units/{unitId}/permits/works` → `201` (a [permit view](#the-permit-view))

**Who:** the unit's **primary resident** only (`PERMIT_NOT_ALLOWED` for anyone else; a unit the caller has no place in: `UNIT_NOT_FOUND`).

```json
{
  "workType": "renovation",
  "startsOn": "2026-11-01",
  "endsOn": "2026-11-20",
  "dailyHours": { "from": "09:00", "to": "15:00" },
  "contractorCompany": "Cairo Finishing Co.",
  "description": "New kitchen tiles and painting the living room."
}
```

| Field | Rule | Error (`fields[]`) |
|---|---|---|
| `workType` | `renovation` or `finishing` | `INVALID_VALUE` |
| `startsOn` | from today, at most 90 days ahead | `DAY_OUT_OF_RANGE` (`params.min`, `params.max`) |
| `endsOn` | not before `startsOn`; the period at most 180 days; holding at least one work day | `ENDS_BEFORE_START`, `PERIOD_TOO_LONG` (`maxDays`), `NOT_A_WORK_DAY` |
| `dailyHours` | `to` after `from`, both inside the compound's hours | `dailyHours.to` `ENDS_BEFORE_START`; `dailyHours` `OUTSIDE_WORK_HOURS` (`params.from`, `params.to`) |
| `contractorCompany` | 1–120 characters | `INVALID_LENGTH` |
| `description` | 1–1000 characters | `INVALID_LENGTH` |

The permit is `pending` until the management decides. A unit holds at most 3 live works permits (pending, or approved and not ended): `409 PERMIT_LIMIT_REACHED` with `params: { "scope": "works", "max": 3 }`.

---

## Contractor workers

### `POST /permits/{id}/workers` → `201` (the permit)

**Who:** the requester or the unit's primary. Only while the permit is pending, or approved and not ended (`409 PERMIT_NOT_ACTIVE` with `params.status`). There is no new approval: the management sees every worker and may take one off.

First upload the worker's face as a file of purpose `contractor_photo` (`POST /files/uploads`, then finalize). Then:

```json
{
  "fullName": "Mahmoud Ali Hassan",
  "photoFileId": "0192f3a4-…",
  "idType": "national_id",
  "idLast4": "4821"
}
```

- `idLast4` is **the last four characters of the ID's number, never more.**
  - four digits for a `national_id`;
  - four letters or digits for a `passport` (case does not matter);
  - else `INVALID_FORMAT`.
- **Never send the whole number, and never a photo of the ID.**
- The server keeps the last four only as a keyed hash, and **nobody sees them again**: not the household, not the management, not the guard. At the gate, the guard types them from the card the worker shows.
- At most 30 workers per permit (`PERMIT_LIMIT_REACHED`, `scope: "workers"`). Removed ones do not count.
- The face must be a finalized `contractor_photo` of the caller, used once (`photoFileId` `FILE_NOT_AVAILABLE`).
- With an `Idempotency-Key`, a retry replays whatever its `idLast4`: the server does not keep it even in the retry's fingerprint.

### `POST /permits/{id}/workers/{workerId}/remove` → `200` (the permit)

The requester or the primary takes a worker off. From then on the guard refuses them (`worker_removed`). Removing a worker twice changes nothing.

---

## Furniture moves

### `POST /units/{unitId}/permits/moves` → `201`

**Who:** the unit's primary.

```json
{
  "date": "2026-11-05",
  "window": { "from": "10:00", "to": "12:00" },
  "truckPlate": "ن ق ل ٤٥٦",
  "itemsDescription": "Two sofas, a fridge and twenty boxes"
}
```

| Field | Rule | Error |
|---|---|---|
| `date` | from today, at most 90 days ahead; a work day and not a day off | `DAY_OUT_OF_RANGE`, `NOT_A_WORK_DAY` |
| `window` | `to` after `from`; inside the work hours; not over already | `window.to` `ENDS_BEFORE_START` or `INVALID_VALUE`; `window` `OUTSIDE_WORK_HOURS` |
| `truckPlate` | a plate as everywhere (Arabic or Latin letters, either digits, spaces), at most 12 characters after tidying | `INVALID_FORMAT` (`maxLength`) |
| `itemsDescription` | 1–1000 characters | `INVALID_LENGTH` |

Pending until the management decides. Two live moves per unit. The guard finds the truck by its plate.

---

## Taking materials out

Bringing materials **in** needs no permit: the guard logs it. Taking materials **out** needs a material exit, approved in advance.

### `POST /units/{unitId}/permits/material-exits` → `201`

**Who:** the unit's primary.

```json
{
  "validFrom": "2026-11-05",
  "validUntil": "2026-11-07",
  "items": [
    { "name": "Old tiles", "quantity": 20 },
    { "name": "Cement bags", "quantity": 4 }
  ],
  "photoFileId": "0192f3a4-…"
}
```

- **`validFrom`:** from today, at most 90 days ahead (`DAY_OUT_OF_RANGE`).
- **`validUntil`:** not before `validFrom`, at most seven days (`PERIOD_TOO_LONG`, `maxDays: 7`).
- **`items`:** 1 to 30 lines, each `name` 1–80 characters and `quantity` 1–9999.
- **`photoFileId`:** optional; a finalized `permit_photo` of the caller.

Five live per unit. Once approved, the guard checks the goods at the exit and marks the permit **used**: once, at whichever gate. The requester gets a push.

---

## Private events and their guests

### `POST /units/{unitId}/permits/events` → `201`

**Who:** anyone the unit lets invite visitors (a member needs the `visitors_invite` grant, as for a visitor pass).

```json
{
  "startsAt": "2026-11-06T16:00:00.000Z",
  "endsAt": "2026-11-06T21:00:00.000Z",
  "title": "Omar’s birthday",
  "guests": [
    { "fullName": "Sara Mostafa", "vehiclePlate": "ABC 123" },
    { "fullName": "Karim Adel" }
  ]
}
```

**The window**
- `startsAt`: not more than 5 minutes ago (`INVALID_VALUE`), and its local day at most 90 days ahead (`DAY_OUT_OF_RANGE`).
- `endsAt`: after `startsAt` (`ENDS_BEFORE_START`), 24 hours at most (`WINDOW_TOO_LONG`, `maxHours: 24`). Past midnight is fine.

**The guests**
- 1 to 150 (`INVALID_LENGTH`). Each name is 2–120 characters; a plate is optional (`guests.N.vehiclePlate` `INVALID_FORMAT`).
- **Up to 20 guests:** the event is `approved` at once (`decisionSource: "auto"`) and may hold 20.
- **21 to 150:** `pending` until the management decides, and may hold exactly as many as listed.

Three upcoming events per unit.

### `POST /permits/{id}/guests` → `201`

`{ "guests": [ { "fullName": "…", "vehiclePlate": "…" } ] }`. The host or the primary adds guests:
- until the event starts (`409 PERMIT_STARTED`);
- never past `guestLimit` (`PERMIT_LIMIT_REACHED`, `scope: "guests"`, `max`): a bigger event is a new request.

### `POST /permits/{id}/guests/{guestId}/remove` → `200`

While the event is open. From then on the guard refuses them (`guest_removed`).

---

## The unit's permits, one permit, cancelling

### `GET /units/{unitId}/permits?kind=&status=&cursor=&limit=` → `200`

Newest first:
- **The unit's primary** sees every permit of the unit.
- **Anyone else with a place there** sees their own (an event they hold).
- **Someone with no place there** gets `UNIT_NOT_FOUND`.

In a list, workers' faces are not presigned (`photo: null`): open the permit for them.

### `GET /permits/{id}` → `200`

The requester's own, or any of the unit's for its primary; else `PERMIT_NOT_FOUND`.

### `POST /permits/{id}/cancel` → `200`

`{ "reasonCode": "plans_changed" }` (optional; from `unitPermitCancel`). The requester or the unit's primary may cancel while the permit is pending, or approved and not ended. Else `409 PERMIT_NOT_ACTIVE` with `params.status` (`ended`, `rejected`, `cancelled`, `revoked`, `used`).

---

## The permit view

Every endpoint above answers with it:

```json
{
  "id": "0192f3a4-…",
  "reference": "W-0042",
  "kind": "works",
  "status": "approved",
  "unitId": "…",
  "unitCode": "B-12",
  "startsAt": "2026-10-31T22:00:00.000Z",
  "endsAt": "2026-11-20T22:00:00.000Z",
  "createdAt": "2026-10-20T08:15:00.000Z",
  "decisionSource": "manager",
  "decidedAt": "2026-10-20T10:02:00.000Z",
  "rejectReason": null,
  "revokedAt": null,
  "revokeReason": null,
  "cancelledAt": null,
  "cancelledBy": null,
  "cancelReason": null,
  "mine": true,
  "requestedBy": { "id": "…", "firstName": "Alia" },
  "works": {
    "workType": "renovation",
    "startsOn": "2026-11-01",
    "endsOn": "2026-11-20",
    "dailyHours": { "from": "09:00", "to": "15:00" },
    "contractorCompany": "Cairo Finishing Co.",
    "description": "New kitchen tiles and painting the living room.",
    "workerCount": 1,
    "workers": [
      {
        "id": "…",
        "fullName": "Mahmoud Ali Hassan",
        "idType": "national_id",
        "photo": { "url": "https://…", "expiresAt": "…" },
        "addedAt": "…",
        "removedAt": null,
        "removedBy": null
      }
    ]
  },
  "move": null,
  "materialExit": null,
  "event": null
}
```

**The kind's object:** exactly one of `works`, `move`, `materialExit` and `event` is set: the permit's own kind.

**`status`:** `pending`, `approved`, `ended` (approved and its window has passed), `rejected`, `cancelled`, `revoked` or `used`.

**`cancelledBy`:**
- `requester`: the requester or the primary cancelled it.
- `system`: with `cancelReason` either `not_decided` (nobody decided it in time) or `requester_left` (the one who asked left the unit, or their account went).

**What the household never sees:** the management's notes, and the last four of anyone's ID.

**What empties later**
- After the requester's erasure, what they wrote is `null`: `contractorCompany`, `description`, `itemsDescription`, `items`, `title`.
- Thirty days after a permit ended, the workers' and guests' names, the faces, the truck's plate and the goods' photo are purged: `null`.

**The other kinds**

| Kind | Its object |
|---|---|
| move | `{ "date", "window": { "from", "to" }, "truckPlate", "itemsDescription" }` |
| material exit | `{ "validFrom", "validUntil", "items": [{ "name", "quantity" }], "photo", "usedAt" }` |
| event | `{ "title", "guestLimit", "guestCount", "guests": [{ "id", "fullName", "vehiclePlate", "removedAt" }] }` |

---

## The guard

Everything here needs `gate.operate` and an **open shift** (`403 NO_OPEN_SHIFT`). The lookups are rate-limited like the code check.

### Finding a permit: `GET /gate/unit-permits?unitCode=B-12` or `?reference=W-42`

Exactly one of the two. It lists the **approved** permits whose window touches today. In this list there are no faces (`photo: null`).

### Opening one: `GET /gate/unit-permits/{id}`

Answers for a permit in force today, or one with someone inside.

```json
{
  "id": "…", "reference": "W-0042", "kind": "works", "status": "approved",
  "unitCode": "B-12", "building": "B",
  "startsAt": "…", "endsAt": "…",
  "hoursToday": { "from": "09:00", "to": "15:00" },
  "works": {
    "workType": "renovation",
    "contractorCompany": "Cairo Finishing Co.",
    "workers": [
      { "id": "…", "fullName": "Mahmoud Ali Hassan", "idType": "national_id",
        "photo": { "url": "https://…", "expiresAt": "…" }, "removed": false, "inside": false }
    ]
  },
  "move": null, "materialExit": null, "event": null
}
```

- **`hoursToday`:** when works or the move may go on today, inside the compound's hours as they stand now. It is `null` on a day off.
- **`event.guests`:** the names to check, **from half an hour before the start to the end**. Otherwise it is `null`, with `guestCount` only.
- **`move.truckPlate`** and **`move.inside`:** the truck, and whether it is in the compound now.

### Letting a contractor in

1. Match the face to `photo`.
2. Ask for their ID card, and type its last four.
3. Record the entry:

```http
POST /gate/entries
Idempotency-Key: <uuid>

{ "subjectType": "permit_worker", "subjectId": "<worker id>", "direction": "in", "idLast4": "4821" }
```

The answer is `201` with `"method": "permit"`.

**`idLast4` rules**
- It is required for a worker's `in`, offline too (`FIELD_REQUIRED`).
- A wrong one is refused: `409 GATE_ENTRY_REFUSED` with `params.reason: "id_mismatch"`.
- **Five wrong ones in 15 minutes lock that guard out**, on every permit. **Ten in a day lock that worker out**, at every gate. Both give `429 PERMIT_ID_LOCKED` with `params.scope` (`guard` or `worker`). The management can unlock either from the permit in the dashboard.

**Other `in` refusals** (`409 GATE_ENTRY_REFUSED`, `params.reason`):

| Reason | When |
|---|---|
| `not_approved` | the permit is pending or rejected |
| `cancelled` | the permit was cancelled |
| `revoked` | the management revoked it |
| `not_yet_valid` | before the permit's window (guests: more than 30 minutes before) |
| `expired` | after the permit's window |
| `day_off` | the compound allows no works or moves today |
| `outside_work_hours` | outside the compound's hours, or (a worker) the permit's daily hours |
| `worker_removed` / `guest_removed` | they were taken off the permit |

**Exits** (`"direction": "out"`) are always recorded, and need no last four. `GET /gate/inside` shows a permit's subject with `kind` (`contractor`, `event_guest` or `move`), `permitId` and `permitReference`, and never a name.

### Event guests and moving trucks

- **A guest:** check the name on the list, then `{ "subjectType": "event_guest", "subjectId": "<guest id>", "direction": "in" }`.
- **A moving truck:** `{ "subjectType": "move_permit", "subjectId": "<permit id>", "direction": "in" }`.
- **`POST /gate/plate-lookup`** also finds an approved move's truck and the car of a guest still on an approved event's list. Its match has `kind: "unit_permit"`, with:
  - `permit.subjectType` and `permit.subjectId`: what to record against;
  - `permit.valid` and `permit.refusal`.

  It never shows a name.

### Materials

- **Out:** `POST /gate/unit-permits/{id}/use` → `200` (the gate view), after checking the goods against `materialExit.items` and the photo. It is used once: a second use, at any gate, is `409 GATE_ENTRY_REFUSED` with `reason: "used"`. A permit that is not approved, not yet valid or over is refused the same way.
- **In:** `POST /gate/material-entries` with `{ "unitCode": "B-12", "permitId": "<works permit, optional>", "description": "20 bags of cement" }` → `201`. It takes an `Idempotency-Key`.

---

## Push notifications

Category `permits`; none is critical.

| Kind | To | Target | Params |
|---|---|---|---|
| `unit_permit.requested` | the management | `unit_permit` | `permitKind` |
| `unit_permit.approved` | the requester | `unit_permit` | `permitKind` |
| `unit_permit.rejected` | the requester | `unit_permit` | `permitKind`, `reason` |
| `unit_permit.revoked` | the requester | `unit_permit` | `permitKind`, `reason` |
| `unit_permit.cancelled` | the requester (`not_decided`), or the unit's primary (`requester_left`) | `unit_permit` | `permitKind`, `reason` |
| `unit_permit.used` | the requester | `unit_permit` | `permitKind` |

- The lock-screen texts are generic, in Arabic and English, and never name anyone.
- Open the permit with `GET /permits/{targetId}`.
- The household gets no push when a contractor comes in or leaves.

---

## Value lists

| List | Values |
|---|---|
| `UnitPermitKind` | `works`, `move`, `material_exit`, `event` |
| `PermitViewStatus` | `pending`, `approved`, `ended`, `rejected`, `cancelled`, `revoked`, `used` |
| `PermitWorkType` | `renovation`, `finishing` |
| `IdDocumentType` | `national_id`, `passport` |
| `unitPermitCancel` (you send) | `plans_changed`, `dates_changed`, `contractor_changed`, `other` |
| `unitPermitSystemCancel` | `requester_left`, `not_decided` |
| `unitPermitReject` | `missing_details`, `outside_rules`, `too_many_guests`, `safety_concern`, `other` |
| `unitPermitRevoke` | `rules_broken`, `safety_concern`, `complaint`, `other` |
| `permitWorkerRemove` (the management) | `misconduct`, `safety_concern`, `not_needed`, `other` |

## Errors

| Code | Status | When |
|---|---|---|
| `PERMIT_NOT_FOUND` | 404 | unknown, another compound's, or not the caller's to see |
| `PERMIT_NOT_ALLOWED` | 403 | not the unit's primary (works, a move, a material exit), or may not invite visitors (an event) |
| `PERMIT_LIMIT_REACHED` | 409 | `params.scope` (`works`, `move`, `material_exit`, `event`, `workers`, `guests`) and `params.max` |
| `PERMIT_NOT_ACTIVE` | 409 | over, or not approved where that is needed (`params.status`) |
| `PERMIT_NOT_PENDING` | 409 | already decided (the management's side) |
| `PERMIT_STARTED` | 409 | adding guests to an event that has started |
| `PERMIT_WORKER_NOT_FOUND` / `PERMIT_GUEST_NOT_FOUND` | 404 | not of this permit |
| `PERMIT_ID_LOCKED` | 429 | the guard or the worker is locked out of the ID check (`params.scope`) |
| `GATE_ENTRY_REFUSED` | 409 | at the gate, with `params.reason` (the table above) |

## Where we differ from the request

- **"Guards see active permits on verify":** contractors and guests carry no code to scan, so verify for a permit is the lookup by unit or reference, then the permit's detail. Entries go through the usual `POST /gate/entries`.
- **Guests' names reach the guard:** the gate checks names against the list. This is the one place the guard sees visitors' names, and only while the event is on.
- **The last four of an ID are never shown again**, not even to the guard. The guard types them from the card, and the server compares.

## Not built

- Move-in and move-out with contracts (R8). A move permit carries no direction (in or out).
- Paying for a permit, or a deposit.
- A live channel: poll the permit; pushes tell.
