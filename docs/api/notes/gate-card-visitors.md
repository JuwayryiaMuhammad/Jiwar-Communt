# Gate card — Visitors: backend notes for the mobile team

What changed for the resident app's Gate card ("Visitors"), and the guard's side of it. The design decisions are in [ADR 0043](../../decisions/0043-gate-card-visitors.md); the contract is `docs/api/openapi.v0.json` (regenerated) and the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`.
- Lists are `{ "data": [...], "nextCursor": string | null }`.
- Errors are `{ "statusCode", "code", "message", "params"?, "fields"?: [{ "field", "code", "params"? }], "requestId", ... }`. Switch on `code` and `fields[].code`, never on `message`.
- Creates take an optional `Idempotency-Key` header (a UUID).
- Responses that carry a secret or a presigned URL are `Cache-Control: no-store`. Do not cache them on the device.

## Contents

1. [A6 — recurring passes failed: the root cause and the working body](#a6--recurring-passes-failed-the-root-cause-and-the-working-body)
2. [A1 — `GET /visitor-passes/{id}`](#a1--get-visitor-passesid)
3. [A2 — the unit's list: entered, exited, entries used](#a2--the-units-list-entered-exited-entries-used)
4. [A3 — cancel reasons](#a3--cancel-reasons)
5. [A5 — vehicle plate](#a5--vehicle-plate)
6. [A7 — group passes (answer)](#a7--group-passes-answer)
7. [A4 — standing instructions](#a4--standing-instructions)
8. [A8 — the guard's photo, the gate's phone, the push](#a8--the-guards-photo-the-gates-phone-the-push)
9. [Value lists](#value-lists)
10. [A9 (answer)](#a9-answer)
11. [Not built](#not-built)

---

## A6 — recurring passes failed: the root cause and the working body

**Root cause.** The backend always took a recurring pass's windows as **times of day** (`HH:mm`, in the compound's time zone). The published contract said otherwise:

- Two backend classes had the same name (`VisitWindowDto`): the visitor schedule's window and a maintenance visit's window.
- Swagger keys schemas by class name, so the maintenance one replaced the visitor one in `openapi.v0.json`, in the generated client and in Postman.
- The contract therefore told you to send `{ "startsAt": <date-time>, "endsAt": <date-time> }`. You did, and every recurring pass got `400 schedule.windows INVALID_FORMAT`.

**Fixed:**

- The classes are renamed (`VisitorScheduleDto`, `VisitorWindowDto`), the contract is correct, and a backend test now fails if two contract classes ever share a name.
- The schedule is validated field by field, so a wrong key is reported precisely.
- The format itself did not change.
- No recurring pass exists anywhere (they all failed), so nothing needs migrating.

The same collision had also mis-documented the body of the primary's decision on a deferred action (`POST /deferred-actions/{id}/decide`) as `approve | deny`. Its real values are `approve | decline` with a reason; the contract is now right (`PermissionDecisionDto`).

**Your body before (refused — 400):**

```json
{
  "kind": "recurring",
  "partySize": 4,
  "validFrom": "2026-10-14T13:00:00.000Z",
  "validUntil": "2026-11-13T13:00:00.000Z",
  "schedule": {
    "days": [2, 4],
    "windows": [{ "startsAt": "2026-10-14T13:00:00.000Z", "endsAt": "2026-10-14T15:00:00.000Z" }]
  },
  "visitorName": "Family visit"
}
```

```json
{
  "statusCode": 400,
  "code": "VALIDATION_FAILED",
  "fields": [
    { "field": "schedule.windows.0.startsAt", "code": "FIELD_NOT_ALLOWED" },
    { "field": "schedule.windows.0.endsAt", "code": "FIELD_NOT_ALLOWED" },
    { "field": "schedule.windows.0.from", "code": "FIELD_REQUIRED" },
    { "field": "schedule.windows.0.to", "code": "FIELD_REQUIRED" }
  ]
}
```

**Working body:** `POST /units/{unitId}/visitor-passes` → `201`. It covers Tuesdays and Thursdays, 16:00–18:00 Cairo time (your 13:00Z–15:00Z in October), for 30 days.

```json
{
  "kind": "recurring",
  "partySize": 4,
  "validFrom": "2026-10-14T13:00:00.000Z",
  "validUntil": "2026-11-13T13:00:00.000Z",
  "schedule": {
    "days": [2, 4],
    "windows": [{ "from": "16:00", "to": "18:00" }]
  },
  "visitorName": "Family visit"
}
```

**Schedule rules:**

- **`days`:** 0 = Sunday … 6 = Saturday, at least one.
- **`windows`:** at least one `{ from, to }`, each `HH:mm` (00:00–23:59) in the **compound's** time zone (not the phone's, not UTC). Daylight-saving changes need nothing from you.
  - `to` before `from` is an overnight window: `{ "from": "22:00", "to": "02:00" }` on day 4 runs Thursday 22:00 → Friday 02:00.
  - `from` equal to `to` is refused (`INVALID_SCHEDULE`).
- **Dates:**
  - `validFrom` may not be more than 5 minutes in the past.
  - `validUntil` is after `validFrom`, at most 180 days later for a recurring pass and 7 days for a one-time pass.
- **One-time passes:** `schedule` is required on recurring passes and refused (`FIELD_NOT_ALLOWED`) on one-time passes.

Errors, as `fields`:

| field | code | when |
|---|---|---|
| `schedule` | `FIELD_REQUIRED` / `FIELD_NOT_ALLOWED` | missing on recurring / present on one-time |
| `schedule.days` | `INVALID_VALUE` (`params: {min: 0, max: 6}`) | empty, or a day outside 0–6 |
| `schedule.windows` | `INVALID_FORMAT` | empty |
| `schedule.windows` | `INVALID_SCHEDULE` | a window with `from` = `to` |
| `schedule.windows.N.from` / `.to` | `INVALID_FORMAT` / `FIELD_REQUIRED` | not `HH:mm` / missing |
| `schedule.windows.N.<other>` | `FIELD_NOT_ALLOWED` | an unknown key |
| `validFrom` | `INVALID_VALUE` | more than 5 minutes in the past |
| `validUntil` | `INVALID_VALUE` (`params: {maxDays}`) | not after `validFrom`, or too far |

---

## A1 — `GET /visitor-passes/{id}`

**New.** Who reads it:

- **The pass itself:** any member of the pass's unit (occupants and household members). An unknown pass and another unit's pass both get `404 VISITOR_PASS_NOT_FOUND`.
- **`code`, `link` and `qrPayload`:** the same values the create returned, while the pass is `active`. Only the pass's host and the unit's primary get them; for everyone else they are `null`.
- **`visitorName`, `visitorPhoneMasked` and `vehiclePlate`:** the host only (`mine: true`); `null` for anyone else. They become `null` for the host too 30 days after the pass ends, when the visitor's data is deleted.
- **Caching:** `no-store`.
- **Old passes:** a pass created before this release shows `code: null` even to its host. `POST /visitor-passes/{id}/reissue-link` gives it a new code, and from then on the detail shows it.

```http
GET /api/v1/visitor-passes/0192d3a4-5b6c-7d8e-9f00-112233445566
```

`200`, as the host:

```json
{
  "id": "0192d3a4-5b6c-7d8e-9f00-112233445566",
  "kind": "one_time",
  "partySize": 3,
  "validFrom": "2026-10-14T13:00:00.000Z",
  "validUntil": "2026-10-14T21:00:00.000Z",
  "schedule": null,
  "status": "active",
  "mine": true,
  "visitorName": "Family visit",
  "vehiclePlate": "ق ب ط ١٢٣٤",
  "entriesUsed": 1,
  "enteredAt": "2026-10-14T14:02:11.000Z",
  "exitedAt": null,
  "createdAt": "2026-10-14T12:55:40.120Z",
  "createdBy": { "id": "0192c0aa-0000-7000-8000-00000000a001", "fullName": "Mona Adel" },
  "code": "482915",
  "link": "https://app.jiwar.eg/v#q3Jz8mY0pR2b6kT9vX1cL4nW7aE5sD0fG3hJ6kL9mN2",
  "qrPayload": "JWR1.q3Jz8mY0pR2b6kT9vX1cL4nW7aE5sD0fG3hJ6kL9mN2",
  "visitorPhoneMasked": "••••4567"
}
```

The same pass, read by another member of the household:

```json
{
  "id": "0192d3a4-5b6c-7d8e-9f00-112233445566",
  "kind": "one_time",
  "partySize": 3,
  "validFrom": "2026-10-14T13:00:00.000Z",
  "validUntil": "2026-10-14T21:00:00.000Z",
  "schedule": null,
  "status": "active",
  "mine": false,
  "visitorName": null,
  "vehiclePlate": null,
  "entriesUsed": 1,
  "enteredAt": "2026-10-14T14:02:11.000Z",
  "exitedAt": null,
  "createdAt": "2026-10-14T12:55:40.120Z",
  "createdBy": { "id": "0192c0aa-0000-7000-8000-00000000a001", "fullName": "Mona Adel" },
  "code": null,
  "link": null,
  "qrPayload": null,
  "visitorPhoneMasked": null
}
```

`createdBy` of an erased account is `{ "id": "...", "erased": true }` (no `fullName`).

---

## A2 — the unit's list: entered, exited, entries used

**Changed:** `GET /units/{unitId}/visitor-passes`. Who sees what is unchanged:

- the unit's primary sees every pass of the unit; anyone else who may invite sees their own;
- `visitorName` and `vehiclePlate` are on the caller's own passes only.

The list gets four new fields:

- **`enteredAt`:** the latest entry through the gate on this pass.
- **`exitedAt`:** the latest exit, once everyone who came in on the pass has left. It is `null` while anyone is inside.
- **`entriesUsed`:** one-time passes only: how many of the `partySize` people came in. It is `null` on a recurring pass. See A7.
- **`vehiclePlate`:** see A5.

```json
{
  "data": [
    {
      "id": "0192d3a4-5b6c-7d8e-9f00-112233445566",
      "kind": "one_time",
      "partySize": 3,
      "validFrom": "2026-10-14T13:00:00.000Z",
      "validUntil": "2026-10-14T21:00:00.000Z",
      "schedule": null,
      "status": "used",
      "mine": true,
      "visitorName": "Family visit",
      "vehiclePlate": "ABC 123",
      "entriesUsed": 3,
      "enteredAt": "2026-10-14T14:20:03.000Z",
      "exitedAt": "2026-10-14T19:41:55.000Z",
      "createdAt": "2026-10-14T12:55:40.120Z"
    }
  ],
  "nextCursor": null
}
```

**`status`** (enum `VisitorPassStatus`, the same on every pass view):

| value | meaning |
|---|---|
| `active` | The code opens the gate, within `validFrom`–`validUntil` and, for a recurring pass, its schedule. |
| `used` | A one-time pass whose whole group came in (`entriesUsed` = `partySize`). The code is dead. |
| `cancelled` | Cancelled by the host or the primary, by the visitor ("this isn't me"), or because the host can no longer invite (left the unit, lost the permission, account deactivated, frozen or erased). The code is dead. |
| `expired` | `validUntil` has passed. The code is dead. |

---

## A3 — cancel reasons

**Changed (documentation only):** `POST /visitor-passes/{id}/cancel` → `204`.

```json
{ "reasonCode": "plans_changed" }
```

`reasonCode` is required and comes from the enum `VisitorPassCancelReason`: `not_needed`, `plans_changed`, `other`. `other` already existed. The list is mirrored in `packages/api/src/reasons.ts`.

| error | when |
|---|---|
| `400 REASON_REQUIRED` (`fields[0].field = reasonCode`) | missing |
| `400 VALIDATION_FAILED`, `fields[0].code = INVALID_REASON_CODE` with `params.allowed` | outside the list |
| `409 VISITOR_PASS_NOT_ACTIVE` (`params.status`) | the pass is used or expired; cancelling a cancelled pass is a no-op `204` |
| `404 VISITOR_PASS_NOT_FOUND` | unknown, or the caller is neither the host nor the primary |

---

## A5 — vehicle plate

**Changed:** `POST /units/{unitId}/visitor-passes` takes an optional `vehiclePlate`.

**Format:**

- **Allowed characters:** Arabic letters, Latin letters (A–Z, a–z), Western digits (0–9), Arabic-Indic digits (٠–٩) and spaces. No dashes, dots or other symbols, and no Persian digits.
- **Tidying:** the server trims it, collapses runs of spaces to one, and upper-cases Latin letters. It stores the result as written, with no transliteration and no digit conversion.
- **Length:** 1–12 characters after tidying.
- **Errors:** anything else is `400 VALIDATION_FAILED` with `{ "field": "vehiclePlate", "code": "INVALID_FORMAT", "params": { "maxLength": 12 } }`.

Examples: `"ق ب ط ١٢٣٤"` → stored `"ق ب ط ١٢٣٤"`; `" abc  123 "` → stored `"ABC 123"`; `"ABC-123"` → refused.

```json
{
  "kind": "one_time",
  "partySize": 2,
  "validFrom": "2026-10-14T13:00:00.000Z",
  "validUntil": "2026-10-14T21:00:00.000Z",
  "visitorName": "Hoda",
  "visitorPhone": "+201012345678",
  "vehiclePlate": "ق ب ط ١٢٣٤"
}
```

**Where it appears:**

- the list and A1, to the host only;
- the guard's code check, `POST /gate/verify` → `display.vehiclePlate`, on a **valid** pass only;
- the host's personal-data export.

It is deleted with the visitor's name and phone, 30 days after the pass ends.

---

## A7 — group passes (answer)

**What the code did before this release:**

- `partySize` was a label shown to the guard.
- The guard recorded **one** entry for the whole group, and that entry used a one-time pass at once.
- Anyone in the group who arrived later was refused (`used`).
- A recurring pass allowed one "in" at a time: nobody else could enter before an exit (`ALREADY_INSIDE`).

**What it does now:**

- **One-time pass:** one code for `partySize` people.
  - Each entry is one person, recorded as its own entry.
  - The pass stays valid until `entriesUsed` reaches `partySize` or `validUntil` passes, at any gate.
  - When the last person comes in, the pass becomes `used` and the code and QR stop working.
  - Entries are serialized on the pass, so two guards at two gates can never let in more than `partySize` (tested with five concurrent entries on a pass for three).
- **Recurring pass:** `partySize` is how many may be **inside at once**, on every visit. Nothing is counted across visits, and `entriesUsed` is `null`.
- **Exits:** one per person. `exitedAt` fills once everyone who came in has left.
- **Guard app (`POST /gate/verify`):**
  - `display.entriesUsed` and `display.insideCount` are new.
  - `next` is `in` while there is room and the pass is valid, otherwise `out` while anyone on it is inside.
  - `POST /gate/entries` records one person per call.
  - An entry on a full one-time pass is `409 GATE_ENTRY_REFUSED` with `params.reason = used`.
  - `GET /gate/inside` shows `insideCount` per pass.

---

## A4 — standing instructions

A household's notes for the guard about people who may come **without a pass**. Each is a few words and an action.

These are new and separate from the existing `GET/PUT /units/{unitId}/gate-instructions` (uninvited visitor: ask / allow / deny; delivery: ask / allow / leave at gate / deny), which is **unchanged**. That endpoint still decides a gate request nobody answers in time.

**Who:**

- **Read and add:** anyone who may invite visitors on the unit (same rule as creating a pass). A member without the `visitors_invite` permission gets `403 FORBIDDEN`; someone with no place in the unit gets `404 UNIT_NOT_FOUND`.
- **Delete:** the instruction's author or the unit's primary. Another inviter gets `403 FORBIDDEN`.
- **Limit:** 20 per unit.
- **When the author can no longer invite:** the instruction stops counting at the gate. This covers an author who left, lost the permission, or was deactivated or frozen. It still appears in the household's list, so the primary can delete it.
- **Personal data:** the description is personal. It is shown to the household and to the guard handling a visitor for the unit, and never appears in a notification or the audit trail. It is deleted with its author and included in the author's data export.

### `GET /units/{unitId}/standing-instructions`

```json
{
  "data": [
    {
      "id": "0192d3b0-1111-7000-8000-0000000000b1",
      "description": "My mother, Hoda, grey Toyota",
      "action": "always_allow",
      "effectiveAction": "always_allow",
      "createdBy": { "id": "0192c0aa-0000-7000-8000-00000000a001", "fullName": "Mona Adel" },
      "createdAt": "2026-10-14T12:00:00.000Z"
    },
    {
      "id": "0192d3b0-2222-7000-8000-0000000000b2",
      "description": "Pharmacy deliveries",
      "action": "leave_at_gate",
      "effectiveAction": "leave_at_gate",
      "createdBy": { "id": "0192c0aa-0000-7000-8000-00000000a002", "fullName": "Karim Adel" },
      "createdAt": "2026-10-14T12:05:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Oldest first. `effectiveAction` is what the guard is shown: `call_first` for an `always_allow` while the compound does not allow those (see below), otherwise the same as `action`.

### `POST /units/{unitId}/standing-instructions` → `201`

```http
POST /api/v1/units/0192c0aa-0000-7000-8000-0000000000u1/standing-instructions
Idempotency-Key: 6f1c2e0a-3b4d-4e5f-8a9b-0c1d2e3f4a5b
```

```json
{ "description": "My mother, Hoda, grey Toyota", "action": "always_allow" }
```

The response is one item, shaped like an element of the list above.

| error | when |
|---|---|
| `400` field `description` `INVALID_LENGTH` (`params: {min: 1, max: 140}`) | empty after trimming, or too long (spaces are tidied) |
| `400` field `action` `INVALID_VALUE` (`params.allowed`) | not one of the four actions |
| `409 ALWAYS_ALLOW_DISABLED` | `always_allow` while the compound does not allow it |
| `409 STANDING_INSTRUCTION_LIMIT_REACHED` (`params.max = 20`) | the unit has 20 |

### `DELETE /units/{unitId}/standing-instructions/{id}` → `204`

`404 STANDING_INSTRUCTION_NOT_FOUND` for an unknown id or another unit's instruction; `403 FORBIDDEN` if the caller is neither its author nor the primary.

### The compound setting `allowAlwaysAllow`

The manager's `PATCH /settings { "allowAlwaysAllow": false }` (default `true`, a toggle on the manager dashboard's settings page). While it is off:

- no new `always_allow` can be added (`409 ALWAYS_ALLOW_DISABLED`);
- existing ones show `effectiveAction: "call_first"` to the household;
- the guard sees them as `call_first`.

The guard logs every entry either way.

### What the guard sees and does

The guard app creates a gate request for an uninvited visitor or a delivery as before. `POST /gate/approval-requests` and `GET /gate/approval-requests/{id}` now carry, while the request is `pending`, the unit's instructions: id, description and the action to follow, never who wrote them. The list is empty for a worker off schedule and once the request is decided.

```json
{
  "id": "0192d3c0-0000-7000-8000-0000000000r1",
  "kind": "uninvited_visitor",
  "unitCode": "B12-04",
  "partySize": 1,
  "status": "pending",
  "decisionSource": null,
  "expiresAt": "2026-10-14T14:03:00.000Z",
  "createdAt": "2026-10-14T14:00:00.000Z",
  "photoUrl": null,
  "standingInstructions": [
    { "id": "0192d3b0-1111-7000-8000-0000000000b1", "description": "My mother, Hoda, grey Toyota", "action": "always_allow" }
  ]
}
```

If the visitor matches one of them, the guard decides by it:

```http
POST /api/v1/gate/approval-requests/0192d3c0-0000-7000-8000-0000000000r1/apply-instruction
```

```json
{ "instructionId": "0192d3b0-1111-7000-8000-0000000000b1" }
```

`200` returns the request, decided:

- `always_allow` → `approved`;
- `never_allow` → `denied`;
- `leave_at_gate` → `leave_at_gate`.

`decisionSource` is `standing_instruction`. The guard then records the entry on the request as for any approval (`POST /gate/entries` with `subjectType: gate_request`).

| error | when |
|---|---|
| `409 STANDING_INSTRUCTION_CALL_FIRST` | the instruction (or its effective action) is `call_first`: wait for the household |
| `409 STANDING_INSTRUCTION_NOT_APPLICABLE` | a worker off schedule: the household answers |
| `409 GATE_REQUEST_DECIDED` (`params.status`) | someone decided first, or the time ran out |
| `404 STANDING_INSTRUCTION_NOT_FOUND` | not one of this unit's live instructions |

---

## A8 — the guard's photo, the gate's phone, the push

### The photo (guard → household)

1. The guard uploads in three steps, as for other photos:
   - `POST /files/uploads { "purpose": "gate_request_photo", "contentType": "image/jpeg", "size": 183224 }`;
   - `PUT` the bytes to `upload.url` with `upload.headers`;
   - `POST /files/{id}/finalize`.

   JPEG, PNG or WebP, 5 MB at most. Only guards (`gate.operate`) may upload this purpose.
2. Then `POST /gate/approval-requests { "kind": "uninvited_visitor", "unitCode": "B12-04", "photoFileId": "<file id>" }`. Any kind may carry a photo.
   - A file that is not the caller's own, not finalized, or already used is `400`, with field `photoFileId` code `FILE_NOT_AVAILABLE`.

**Who sees it:** the household members who are asked (`GET /me/gate-requests` → `photoUrl`) and the guards (the request views → `photoUrl`).

- `photoUrl` is a presigned URL valid for about **5 minutes**. Load it right away and never store it; re-read the list for a fresh one.
- These responses are now `no-store`.

**Retention:** the photo is deleted **7 days after the request is decided** (approved, denied, left at the gate, timed out or withdrawn). After that, `photoUrl` is `null`.

### The gate's phone

- **Who sets it:** the manager, on `POST /gates` or `PATCH /gates/{id}` (`"phone": "+20225550100"`; `null` removes it).
- **Format:** stored as E.164. An invalid number is `400`, field `phone`, code `INVALID_PHONE`.
- **Where it shows:** the manager dashboard's gate dialog and table.

`GET /me/gate-requests` (changed: `photoUrl`, `gatePhone`; `no-store`):

```json
{
  "data": [
    {
      "id": "0192d3c0-0000-7000-8000-0000000000r1",
      "kind": "uninvited_visitor",
      "unitId": "0192c0aa-0000-7000-8000-0000000000u1",
      "unitCode": "B12-04",
      "gateName": "Main gate",
      "partySize": 1,
      "visitorName": "Hoda",
      "workerName": null,
      "photoUrl": "https://files.jiwar.eg/jiwar/0192.../0192d3c1-...?X-Amz-Expires=300&X-Amz-Signature=…",
      "gatePhone": "+20225550100",
      "expiresAt": "2026-10-14T14:03:00.000Z",
      "createdAt": "2026-10-14T14:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

`GET /gates/status` (changed: `phone`):

```json
{
  "data": [
    { "id": "0192c0bb-0000-7000-8000-0000000000g1", "name": "Main gate", "open": true, "phone": "+20225550100" },
    { "id": "0192c0bb-0000-7000-8000-0000000000g2", "name": "Service gate", "open": false, "phone": null }
  ],
  "nextCursor": null
}
```

The household answers as before with `POST /gate-requests/{id}/decide { "decision": "approve" | "deny" }`.

### The push for a new gate request

This already existed and is unchanged:

- **Kind:** `gate.approval_requested`. It goes to every household member who may invite visitors on the unit, in the inbox and by push.
- **Lock-screen text:** generic, with no visitor name. English: "Someone is at the gate" / "Someone is waiting at {gateName} for unit {unitCode}. Open the app to answer." Arabic: "زائر عند البوابة" / "يوجد من ينتظر عند {gateName} للوحدة {unitCode}. افتح التطبيق للرد."
- **Data:** `targetId` is the request's id; open `GET /me/gate-requests`.
- **Critical:** it is **critical**, so it arrives even during quiet hours or a pause. A visitor waits at the gate, and a request nobody answers in time falls back to the household's gate-instructions.

---

## Value lists

| list | values |
|---|---|
| `VisitorPassKind` | `one_time`, `recurring` |
| `VisitorPassStatus` | `active`, `used`, `cancelled`, `expired` (meanings in A2) |
| `VisitorPassCancelReason` | `not_needed`, `plans_changed`, `other` |
| `StandingInstructionAction` | `always_allow` (the guard lets them in and logs the entry), `never_allow` (the guard turns them away), `call_first` (the guard asks the household first), `leave_at_gate` (what they bring stays at the gate) |
| `GateRequestKind` | `uninvited_visitor`, `delivery`, `worker_off_schedule` |
| `GateRequestStatus` | `pending`, `approved`, `denied`, `timed_out`, `leave_at_gate`, `withdrawn` |
| `GateDecisionSource` | `household`, `standing_instruction`, `timeout`, `guard` (a withdrawal) |
| Gate decide (`POST /gate-requests/{id}/decide`) | `approve`, `deny` |
| Verify `reason` (guard) | `unknown_code`, `not_yet_valid`, `expired`, `outside_schedule`, `host_inactive`, `used`, `cancelled`, `suspended`, `ended`, `banned`, `not_approved`, `expired_qr`, `not_resident`, `account_inactive`, `revoked` |
| Vehicle plate | Arabic letters, A–Z, a–z, 0–9, ٠–٩, spaces; 1–12 after tidying |
| Schedule window | `HH:mm` 00:00–23:59, compound time zone; `to` < `from` = overnight |
| Days | 0 (Sunday) … 6 (Saturday) |

New error codes: `STANDING_INSTRUCTION_NOT_FOUND` (404), `STANDING_INSTRUCTION_LIMIT_REACHED` (409), `ALWAYS_ALLOW_DISABLED` (409), `STANDING_INSTRUCTION_CALL_FIRST` (409), `STANDING_INSTRUCTION_NOT_APPLICABLE` (409).

---

## A9 (answer)

**Yes.** Visitor parking and the visitor's arrival route inside the compound are planned in the **Vehicles** phase (part B). Nothing about them is in this release.

---

## Not built

- **A group arriving together:** the guard records one entry per person; there is no `count` on `POST /gate/entries`.
- **A notification when a visitor is let in by an `always_allow` instruction:** the household is not told. The entry is in the gate log, and the pass-less visitor's request disappears from `GET /me/gate-requests` once decided.
- **A history of decided gate requests for residents:** `GET /me/gate-requests` shows only pending ones, so the visitor's photo is visible only while the request waits.
- **Editing a standing instruction:** delete it and add a new one.
- **Vehicles and parking** are in [`gate-card-vehicles.md`](gate-card-vehicles.md); **emergencies and gate services** in [`gate-card-emergency-services.md`](gate-card-emergency-services.md); the clinic is not built.
