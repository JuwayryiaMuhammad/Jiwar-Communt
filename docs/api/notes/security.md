# Security operations: backend notes for the guard app

What was built for a guard's security work (ADR 0053):
- an SOS from your post;
- locking the gates down, and letting an emergency vehicle through;
- the blocklist at the gate: the list, the flags at verify and plate lookup, an ID lookup, a refused entry;
- stopping a contractor's work;
- reporting an incident, and acknowledging it;
- issuing a violation to a unit.

The management's side (ending a lockdown, keeping the blocklist, investigating incidents, deciding appeals, payments, the reports) is in the manager dashboard.
- The design decisions are in [ADR 0053](../../decisions/0053-incidents-blocklist-lockdown-violations.md).
- The contract is `docs/api/openapi.v0.json` (regenerated) and the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`. Every route here needs `gate.operate` (the guard role) and an open shift (403 `NO_OPEN_SHIFT`), at a gate or in a zone unless said otherwise.
- Errors are `{ "statusCode", "code", "message", "params"?, "fields"?: [...] }`. Switch on `code` and `fields[].code`, never on `message`.
- **Every response is `Cache-Control: no-store`.** Do not cache them on the device: the blocklist least of all.
- Writes marked *idempotent* take an `Idempotency-Key` header (a UUID); a retry with the same key and body answers the same.
- Instants are ISO 8601 UTC; days are the compound's `YYYY-MM-DD`.
- Units appear by code and building, residents and colleagues by first name (`{ id, firstName }`, or `{ id, erased: true }`).

## Contents

1. [An SOS from your post](#an-sos-from-your-post)
2. [The lockdown](#the-lockdown)
3. [The blocklist at the gate](#the-blocklist-at-the-gate)
4. [Stop work](#stop-work)
5. [Incidents](#incidents)
6. [Violations](#violations)
7. [Push notifications](#push-notifications)
8. [Value lists](#value-lists)
9. [Errors](#errors)
10. [Not built](#not-built)

---

## An SOS from your post

### POST /gate/emergencies `{ type }` → 201 (or 200) `StaffEmergencyView` · idempotent

An emergency raised from the post of your open shift (a gate or a zone), with a `type` from `EmergencyType` (ADR 0047).
- **Told at once, critically:** the other guards on shift, the responders and the management (`emergency.reported`). No household is.
- **One open per post and type:** a second one answers **200** with the open one. Show it, do not raise again.
- In the answer, `location` is null and `post` names your gate or zone.
- **You never accept your own** (403 `EMERGENCY_OWN`). You are told when a responder is on the way (`emergency.responder_on_the_way`).

### POST /gate/emergencies/{id}/cancel `{ reasonCode? }` → 200 `StaffEmergencyView`

Yours, while it is open, with an `emergencyCancel` code or none. Another guard's SOS is 404 `EMERGENCY_NOT_FOUND`. Those told are told it is over.

## The lockdown

### POST /gate/lockdowns → 201 (or 200) `GuardLockdownView` · idempotent

```json
{ "scope": "gate", "gateId": "…", "reasonCode": "intruder", "confirmation": "LOCKDOWN" }
```

- `scope`: `gate` (with `gateId`) or `all` (no `gateId`).
- `reasonCode` from `gateLockdownStart`.
- **`confirmation` must be exactly `LOCKDOWN`, typed by the guard.** This is the confirm step: there is no second request. Ask for the word in a dialog that says what happens.
- Immediate. The guards on shift and the management get a critical push; every resident a generic critical one.
- **One live lockdown per scope:** a repeat answers **200** with the live one and tells nobody again.

`GuardLockdownView`: `id`, `scope`, `gate { id, name }` (null for every gate), `reasonCode`, `startedAt`, `startedBy` (first name).

### GET /gate/lockdowns/active → `[GuardLockdownView]`

The live lockdowns: each gate's own, and the one of every gate. **Poll it** (every 10–15 s) or refresh it on the `gate_lockdown.*` pushes, and show a banner while it is not empty.

### While your gate is locked down

- **Nobody but a resident comes in:** `POST /gate/entries` with `direction: "in"` answers 409 `LOCKDOWN_ACTIVE` (`params.scope`), for every subject.
- `POST /gate/verify` answers `valid: false`, `reason: "lockdown_active"`. A resident's QR is valid as before.
- A gate request (`POST /gate/approval-requests`) and a material entry are 409 `LOCKDOWN_ACTIVE`: the household is never asked.
- The plate lookup's passes and permits say `refusal: "lockdown_active"`.
- **Exits always go through.** An entry you record offline is judged at the moment it happened: one inside a lockdown is refused when it arrives, even if the lockdown ended since.
- Only the management ends a lockdown (in the dashboard). You are told (`gate_lockdown.ended`).

### POST /gate/lockdowns/{id}/overrides → 201 `LockdownOverrideView`

An emergency vehicle let through your locked gate.

```json
{ "reasonCode": "ambulance", "emergencyId": "…", "gateServiceRequestId": "…" }
```

- At the gate of your shift, which the lockdown must hold (409 `LOCKDOWN_NOT_AT_GATE`).
- `reasonCode` from `gateLockdownOverride`; link the emergency or the lane request it answers when there is one.
- It is recorded and audited. It is not an entry: do not record one for the vehicle.

## The blocklist at the gate

The management bans plates and people (refused at the gate) or watches them (let in, the management told).

### GET /gate/blocklist → `[GuardBlocklistEntryView]`

The active entries, for your shift: `id`, `kind` (`ban`, `watch`), `subject` (`plate`, `person`), `plate`, `fullName`, `photo { url, expiresAt }` (a face), `since`.
- **Never why, the note or an ID number.**
- Keep it in memory only while your shift lasts, and fetch it again often: it changes.

### Flags where you already check

- **`POST /gate/verify`:** a pass whose plate is banned answers `valid: false`, `reason: "entry_blocked"`. A watched one is valid. In both, `display.blocklist` names the entry (`{ entryId, kind }`): show the guard the face from the list.
- **`POST /gate/plate-lookup`:** gains `blocklist: [{ entryId, kind }]`. A ban refuses every pass and permit the plate names (`refusal: "entry_blocked"`).
- **`POST /gate/entries` in:** a banned plate on the subject (a pass's or gate request's visitor, an event guest's car, a move's truck) is 409 `ENTRY_BLOCKED`. Nothing is recorded but the refusal; a retry with the same key asks again. **Never tell the visitor why.**
- **`POST /gate/approval-requests`** gains `vehiclePlate` (kept with the visitor's details) and `idNumber` (matched, never stored). A ban is 409 `ENTRY_BLOCKED` before the household is asked. A watch is asked as any.

The household learns only that security refused their visitor, once, never why.

### POST /gate/id-lookup `{ idNumber }` → 200 `{ matches: [GuardBlocklistEntryView] }`

The full number on the card. At a gate, on your own rate limit (429 `RATE_LIMITED`).
- `matches` is the person's live entries; empty when there are none.
- The number is never stored or logged: do not keep it on the device either.

## Stop work

### POST /gate/unit-permits/{id}/stop-work `{ reasonCode }` → 200 `GuardWorkStopView`

An approved works permit in force (409 `PERMIT_NOT_ACTIVE` otherwise; 409 `PERMIT_WORK_STOPPED` when stopped already), with a `permitWorkStop` code.
- Answers `{ permitId, reference, unitCode, workStopped: { since, reasonCode } }`.
- **Its workers are refused at the gate from then:** an entry in is 409 `GATE_ENTRY_REFUSED` with `params.reason: "work_stopped"`. Workers inside always leave.
- The requester, the unit's primary and the permits' staff are told. Only the staff resume it.
- The gate's works views show `workStopped` (or null).

## Incidents

### POST /gate/incidents → 201 `GuardIncidentView` · idempotent

```json
{
  "type": "hazard",
  "severity": "medium",
  "placeId": "…",
  "unitCode": "B7-12",
  "occurredAt": "2026-11-02T21:40:00.000Z",
  "description": "A loose cable by the pool",
  "photoFileIds": ["…"],
  "emergencyId": "…"
}
```

- `type` from `incidentType`, `severity` from `incidentSeverity`.
- Where: `placeId` (a place in service) and/or `unitCode`, at least one.
- `occurredAt`: not ahead, at most 30 days back.
- `description`: 1 to 4000 characters.
- `photoFileIds`: up to five uploads of purpose `incident_photo`.
- Optional links: `emergencyId`, `gateServiceRequestId`, `patrolNoteId` (404 `INCIDENT_LINK_NOT_FOUND`, `params.field`).
- The management is told; a `critical` one is a critical push. **It never changes once filed**: write it carefully.

`GuardIncidentView`: `id`, `reference` (`I-0042`), `type`, `severity`, `status` (`open`, `investigating`, `closed`), `place`, `unit { unitId, unitCode, building }`, `occurredAt`, `reportedAt`, `description`, `photos`, `links`, `outcome`, `closedAt`, `authorAcknowledgedAt`, `reviewerAcknowledgedAt`.
- **You never see** the investigator, the internal notes or the closing note.

### GET /gate/incidents, GET /gate/incidents/{id}

The incidents you reported, newest first. Another's is 404 `INCIDENT_NOT_FOUND`.

### POST /gate/incidents/{id}/acknowledge → 200 `GuardIncidentView`

Acknowledge an incident you reported, once (for example after reading its outcome); again answers the same.

## Violations

### POST /gate/violations → 201 `GuardViolationView` · idempotent

```json
{ "kind": "noise", "unitCode": "B7-12", "placeId": "…", "occurredOn": "2026-11-02", "note": "Music after midnight", "amount": "250", "photoFileId": "…" }
```

- `kind` from `violationKind`.
- `unitCode`, or for `contractor_hours` a `permitId` of the unit's works permit instead (the unit is the permit's). `permitId` with another kind is `FIELD_NOT_ALLOWED`.
- `occurredOn`: at most 90 days back.
- `note`: the unit reads it.
- `amount` in EGP, or none: **a warning**.
- A photo of purpose `violation_photo`.

The unit's people are told by the kind alone. They never see who issued it.

`GuardViolationView`: `id`, `reference` (`V-0042`), `kind`, `unitCode`, `date`, `amount` (null for a warning), `status`.

## Push notifications

The guard app receives:

| Kind | When |
|---|---|
| `emergency.reported` (critical) | another guard's SOS, as any emergency |
| `emergency.responder_on_the_way` | someone answers your SOS |
| `gate_lockdown.started` (critical) | a lockdown starts (`params.scope`: `gate`, `all`) |
| `gate_lockdown.ended` | it ends |

Params are codes only: refresh the screen from the API.

## Value lists

| List | Values |
|---|---|
| `gateLockdownStart` | security_threat, intruder, violence, fire, police_request, drill, other |
| `gateLockdownOverride` | ambulance, fire_truck, police, civil_defense |
| `emergencyCancel` | false_alarm, resolved_ourselves, other |
| `permitWorkStop` | safety_hazard, outside_hours, noise_complaint, unauthorized_work, damage, other |
| `incidentType` | injury, near_miss, hazard, security_breach, property_damage, fire, other |
| `incidentSeverity` | low, medium, high, critical |
| `violationKind` | noise, waste, pets, contractor_hours, other |

The lists are also in `packages/api` (`REASON_CODES`).

## Errors

| Code | When |
|---|---|
| `NO_OPEN_SHIFT` (403) | no open shift |
| `EMERGENCY_OWN` (403) | accepting your own SOS |
| `LOCKDOWN_ACTIVE` (409) | an entry in, a gate request or a material entry at a locked gate (`params.scope`) |
| `LOCKDOWN_NOT_AT_GATE` (409) | an override where no lockdown holds your gate |
| `LOCKDOWN_ENDED` (409) | an override on an ended lockdown |
| `ENTRY_BLOCKED` (409) | a banned plate or person: refused, never say why |
| `GATE_ENTRY_REFUSED` (409, `params.reason: work_stopped`) | a worker of a stopped permit |
| `PERMIT_NOT_ACTIVE`, `PERMIT_WORK_STOPPED` (409) | stopping work that is not in force, or stopped already |
| `INCIDENT_NOT_FOUND` (404), `INCIDENT_LINK_NOT_FOUND` (404) | another's incident; a link that is not found |
| `UNIT_CODE_UNKNOWN` (field) | a unit's code that is not the compound's, or not the permit's |
| `DAY_OUT_OF_RANGE` (field) | a violation's day more than 90 days back |
| `RATE_LIMITED` (429) | too many ID lookups |
| `VALIDATION_FAILED` (400) | a malformed body: see `fields[]` |

## Not built

- Residents' registered vehicles and domestic workers' stored IDs are not matched against the blocklist.
- Repeated match notifications are not deduplicated.
- No control room, cameras, audio or video.
