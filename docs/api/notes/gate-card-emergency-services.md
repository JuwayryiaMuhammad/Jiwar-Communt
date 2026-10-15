# Gate card — Emergencies and gate services: backend notes for the mobile team

What was built for the resident app's Gate card, parts C and D (emergencies, emergency contacts, accessibility help, suspicious-activity reports, escorts, lanes, places), and the guard's side of it.
- The design decisions are in [ADR 0047](../../decisions/0047-emergencies-and-gate-services.md).
- The contract is `docs/api/openapi.v0.json` (regenerated) and the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`.
- Lists are `{ "data": [...], "nextCursor": string | null }`; pass `nextCursor` back as `?cursor=`.
- Errors are `{ "statusCode", "code", "message", "params"?, "fields"?: [{ "field", "code", "params"? }], "requestId", ... }`. Switch on `code` and `fields[].code`, never on `message`.
- Creates take an optional `Idempotency-Key` header (a UUID): a retry with the same key answers the same, once.
- **Every response here is `Cache-Control: no-store`.** They carry phones, names and presigned photo URLs. Do not cache them on the device.
- Instants are ISO 8601 UTC.

## Contents

1. [C8 — the clinic (answer)](#c8--the-clinic-answer)
2. [Places (D4)](#places-d4)
3. [Emergency contacts (C4)](#emergency-contacts-c4)
4. [Report an emergency (C1)](#report-an-emergency-c1)
5. [Follow an emergency (C2)](#follow-an-emergency-c2)
6. [The family (C3)](#the-family-c3)
7. [Gate services (C7, D1–D3)](#gate-services-c7-d1d3)
8. [My requests (D5)](#my-requests-d5)
9. [The guard](#the-guard)
10. [Push notifications](#push-notifications)
11. [Value lists](#value-lists)
12. [Errors](#errors)
13. [Where we differ from your contract](#where-we-differ-from-your-contract)
14. [Not built](#not-built)

---

## C8 — the clinic (answer)

**The clinic is not part of the compound's system, and it is not planned.** Hide the "Book a doctor" (C5) and "Children's vaccinations" (C6) screens. Nothing in the API serves them.

---

## Places (D4)

### `GET /community/places` → `200`

**Who:** residents and family (and the guards). The places in service, in the management's order. Bounded: `nextCursor` is always null.

```json
{
  "data": [
    { "id": "01a1…01", "key": "main_gate", "nameEn": "Main gate", "nameAr": "البوابة الرئيسية" },
    { "id": "01a1…02", "key": "north_gate", "nameEn": "North gate", "nameAr": "البوابة الشمالية" },
    { "id": "01a1…03", "key": "phase_a", "nameEn": "Phase A", "nameAr": "المرحلة أ" },
    { "id": "01a1…04", "key": "phase_b", "nameEn": "Phase B", "nameAr": "المرحلة ب" },
    { "id": "01a1…05", "key": "clubhouse", "nameEn": "Clubhouse", "nameAr": "النادي" },
    { "id": "01a1…06", "key": "parking", "nameEn": "Parking", "nameAr": "الجراج" },
    { "id": "01a1…09", "key": null, "nameEn": "Phase C", "nameAr": "المرحلة ج" },
    { "id": "01a1…07", "key": "other", "nameEn": "Other", "nameAr": "مكان آخر" }
  ],
  "nextCursor": null
}
```

- Every compound starts with the seven of your list, each with a `key`. Name those in your own words if you like, by `key`. The management may rename them, and adds places of its own (`key: null`): show `nameEn` or `nameAr`.
- Requests take **place ids**, never keys. Read the list when the screen opens.
- A place the management retired is gone from the list. A request naming it gets `404 PLACE_NOT_FOUND`, with `params.field`.

---

## Emergency contacts (C4)

### `GET /units/{unitId}/emergency-contacts` → `200`

**Who:** anyone the unit gives the emergency button (`emergency` in `GET /me/units/{unitId}/capabilities`). Another unit gets `404 UNIT_NOT_FOUND`.

```json
{
  "family": [
    { "accountId": "01b2…", "name": "Mona Hassan", "role": "owner", "isPrimary": true, "phone": "+201001234567" },
    { "accountId": "01b3…", "name": "Omar Hassan", "role": "member", "isPrimary": false, "phone": "+201007654321" }
  ],
  "gates": [
    { "gateId": "01c4…", "name": "Main gate", "role": "gate", "phone": "+20225550110" },
    { "gateId": "01c5…", "name": "North gate", "role": "gate", "phone": "+20225550111" }
  ],
  "management": [
    { "role": "office", "phone": "+20225550101" },
    { "role": "duty", "phone": "+201000000555" },
    { "role": "emergency", "phone": "+20225550199" }
  ]
}
```

- **family:** the *other* people who live in the unit: residing owners and tenants, and adult household members with an account. The primary comes first.
  - Minors without an account are not listed.
  - A landlord (an owner who does not live there) gets `family: []`: the household's phones are for those who live together.
- **gates:** the gates in service that have a phone, by name.
- **management:** each of the three when the management has set it. `name` is not sent: name them by `role` (`office`: the community office; `duty`: the duty manager; `emergency`: the compound's emergency number).

---

## Report an emergency (C1)

### `POST /emergencies` → `201` (new) or `200` (one was open)

**Who:** anyone the unit gives the emergency button: an owner, a tenant, a family member, a landlord too. **Never rate-limited.**

```json
{ "type": "medical", "unitId": "01d6…" }
```

**One open emergency per unit and type.** If a `medical` one is already open in the unit (reported, on the way or arrived), you get it back with `200`. Nothing is sent twice. Follow it as any other. A retry with the same `Idempotency-Key` answers the same, with the same status.

The answer is the emergency as in C2. A new one:

```json
{
  "id": "01e7…",
  "reference": "E-0042",
  "type": "medical",
  "status": "reported",
  "reportedAt": "2026-10-25T10:00:00.000Z",
  "location": { "unitId": "01d6…", "unitCode": "12", "building": "Building 7" },
  "reportedBy": { "id": "01b3…", "firstName": "Omar" },
  "responder": null,
  "minutesAway": null,
  "familyNotified": 1,
  "familyOnTheWay": 0,
  "timeline": [
    { "step": "reported", "at": "2026-10-25T10:00:00.000Z" },
    { "step": "security_notified", "at": "2026-10-25T10:00:00.000Z" }
  ],
  "closeReason": null,
  "onMyWay": null,
  "canCancel": true
}
```

**What happens at once**
- Every guard on an open shift, and every staff member the compound made a responder, gets a critical push. Critical means never muted, never held by quiet hours.
- The others who live in the unit get a critical push too (C3).
- **If there is nobody to tell** (no guard on shift, no responder), the management gets a critical push at once and the timeline shows `management_notified`.
- **If nobody accepts within two minutes**, the management gets one then (escalation, once).

---

## Follow an emergency (C2)

### `GET /emergencies/{id}` → `200`

**Who:** the reporter and the household members who were alerted. Anyone else gets `404 EMERGENCY_NOT_FOUND`.

After a guard accepted it:

```json
{
  "id": "01e7…",
  "reference": "E-0042",
  "type": "medical",
  "status": "on_the_way",
  "reportedAt": "2026-10-25T10:00:00.000Z",
  "location": { "unitId": "01d6…", "unitCode": "12", "building": "Building 7" },
  "reportedBy": { "id": "01b3…", "firstName": "Omar" },
  "responder": { "firstName": "Karim", "phone": "+20225550110" },
  "minutesAway": 4,
  "familyNotified": 1,
  "familyOnTheWay": 1,
  "timeline": [
    { "step": "reported", "at": "2026-10-25T10:00:00.000Z" },
    { "step": "security_notified", "at": "2026-10-25T10:00:00.000Z" },
    { "step": "on_the_way", "at": "2026-10-25T10:00:40.000Z" },
    { "step": "family_on_the_way", "at": "2026-10-25T10:01:05.000Z", "firstName": "Mona" }
  ],
  "closeReason": null,
  "onMyWay": null,
  "canCancel": true
}
```

**The responder:** a first name and **the phone of the gate where they are on shift**. When the management answers from its office, it is the compound's duty phone (else its emergency number). Never anyone's own phone.

**`minutesAway`:** there is no GPS.
- The responder picks 2, 5, 10 or 15 minutes when they accept, and the count runs down from then.
- It is null before anyone accepts and once the emergency is closed, and 0 once they arrived. It never goes below 0: late is "any moment now".
- Read the emergency again to refresh it; poll every few seconds while the screen is open.

**`timeline`:** in time order.

| Step | When |
|---|---|
| `reported` | always |
| `security_notified` | responders were told (same time as `reported`) |
| `management_notified` | escalated: nobody on shift, or nobody accepted within two minutes |
| `on_the_way` | a responder accepted |
| `arrived` | they arrived |
| `family_on_the_way` | one per member who answered, with their `firstName` |
| `resolved` / `cancelled` | closed |

### `GET /me/emergencies?status=open|closed` → `200`

The emergencies the caller reported or was alerted to, newest first. Use `status=open` to resume the follow screen after the app restarts.

### `POST /emergencies/{id}/cancel` → `200`

**Who:** the reporter or the unit's primary (`canCancel`), while the emergency is open. Others who see it get `403 EMERGENCY_ACTION_NOT_ALLOWED`; once closed, `409 EMERGENCY_CLOSED`.

```json
{ "reasonCode": "false_alarm" }
```

`reasonCode` is optional, from `emergencyCancel`. The responder is told; with none yet, every guard on shift and every responder, and the management once it was escalated.

---

## The family (C3)

- When someone reports an emergency, **every other person who lives in the unit** gets a critical push.
- **The lock screen says only "Emergency reported from your unit"** (Arabic: «تم الإبلاغ عن حالة طارئة من وحدتك»), never a name, a type or a unit.
- The details are in the app: `GET /emergencies/{id}` (the push carries the emergency's id).

### `POST /emergencies/{id}/on-my-way` → `200`

**Who:** a member who was alerted, while the emergency is open. Once: a second call changes nothing.
- The reporter gets `403 EMERGENCY_ACTION_NOT_ALLOWED`: they are there already.
- After it closed: `409 EMERGENCY_CLOSED`.
- The answer is the emergency, with `onMyWay: true`, `familyOnTheWay` counted and a `family_on_the_way` step in the timeline.

---

## Gate services (C7, D1–D3)

**Who:** someone who lives in the unit (`gateEntry` in the capabilities). A landlord gets `403 GATE_SERVICE_NOT_ALLOWED`; another unit gets `404 UNIT_NOT_FOUND`.

**Limits** (`409 GATE_SERVICE_LIMIT_REACHED`, with `params.max` and `params.scope`):
- `scope: "open"`: 3 open (open, accepted or in progress) of the same kind per unit;
- `scope: "day"`: 20 requests per unit in any 24 hours, all kinds together.

**Security is told at once.** The guards on shift and the staff who handle requests get a push; a lane's own gate is told first.

Every request returns the same shape (`reference` `A-…` for accessibility help, `S-…` for the others):

```json
{
  "id": "01f8…",
  "reference": "A-0007",
  "kind": "accessibility",
  "status": "open",
  "createdAt": "2026-10-25T10:00:00.000Z",
  "unitId": "01d6…",
  "assistanceKind": "wheelchair",
  "member": { "id": "01b9…", "firstName": "Nadia" },
  "fromPlace": { "id": "01a1…01", "key": "main_gate", "nameEn": "Main gate", "nameAr": "البوابة الرئيسية" },
  "toPlace": null,
  "place": null,
  "when": "in_15",
  "wantedAt": "2026-10-25T10:15:00.000Z",
  "description": null,
  "photoUrl": null,
  "laneReason": null,
  "gate": null,
  "notes": null,
  "minutesAway": null,
  "handler": null,
  "acceptedAt": null,
  "startedAt": null,
  "closedAt": null,
  "closeReason": null,
  "cancelledAt": null,
  "canCancel": true
}
```

**Once security accepts:**
- `handler` is `{ "firstName": "Karim", "phone": "+20225550110" }` (the gate's phone, as for emergencies);
- `minutesAway` counts down when they gave minutes. They always do for accessibility help and escorts.

### `POST /accessibility-requests` (C7) → `201`

```json
{
  "unitId": "01d6…",
  "assistanceKind": "wheelchair",
  "memberId": "01b9…",
  "fromPlaceId": "01a1…01",
  "toPlaceId": null,
  "when": "in_15"
}
```

- `memberId`: a household member's id (`GET /units/{unitId}/household`), a minor included. Omit it or send null for the caller. Another unit's member gets `404 HOUSEHOLD_MEMBER_NOT_FOUND`.
- `toPlaceId`: omit it or send null for "to the unit".

### `POST /security-reports` (D1) → `201`

```json
{
  "unitId": "01d6…",
  "placeId": "01a1…04",
  "description": "A man trying car doors near the gym",
  "photoFileId": "01fa…"
}
```

- `description` is 1–1000 characters.
- The photo uses the 3-step upload with purpose `gate_service_photo` (an image, 5 MB). It must be the caller's, finalized and unused; otherwise you get `400`, `fields[0].code = FILE_NOT_AVAILABLE`.
- `photoUrl` comes back presigned, valid for minutes.

### `POST /escort-requests` (D2) → `201`

```json
{ "unitId": "01d6…", "fromPlaceId": "01a1…06", "toPlaceId": "01a1…04", "when": "now" }
```

### `POST /lane-requests` (D3) → `201`

```json
{ "unitId": "01d6…", "reason": "moving_truck", "gateId": "01c4…", "notes": "A truck at 4 pm" }
```

- `gateId` comes from `GET /gates/status`. A gate out of service gets `404 GATE_NOT_FOUND`.
- `notes` is optional, 1–500 characters.

### `POST /gate-services/{id}/cancel` → `200`

The requester, while the request is `open`. After security accepted it you get `409 GATE_SERVICE_NOT_OPEN` with `params.status`: call the gate (`handler.phone`).

---

## My requests (D5)

### `GET /me/gate-services?status=&kind=` → `200`

The caller's requests of all four kinds, newest first. `status` and `kind` are optional filters.

### `GET /gate-services/{id}` → `200`

One of the caller's requests. Anyone else's gets `404 GATE_SERVICE_NOT_FOUND`.

**Statuses:**

| Status | Meaning |
|---|---|
| `open` | waiting for security; the requester may cancel |
| `accepted` | someone is coming (`handler`, `minutesAway`) |
| `in_progress` | being done |
| `closed` | done; `closeReason` says how |
| `cancelled` | by the requester, or because the requester left the compound |

---

## The guard

A guard acts inside an open shift. Without one they get `403 NO_OPEN_SHIFT`. A guard never sees a resident's phone.

**Emergencies:** `GET /gate/emergencies?status=open|closed`, `GET /gate/emergencies/{id}`.
- `POST /gate/emergencies/{id}/accept` with `{ "etaMinutes": 5 }`. The first to accept wins; the others get `409 EMERGENCY_ALREADY_ACCEPTED`.
- `POST /gate/emergencies/{id}/arrived`: the responder only.
- `POST /gate/emergencies/{id}/resolve` with `{ "reasonCode": "handled", "note": "…" }`. The note is for the management; the household never sees it.

**Gate services:** `GET /gate/gate-services?status=&kind=`, `GET /gate/gate-services/{id}`.
- `POST …/accept` with `{ "etaMinutes": 10 }`, required for accessibility and escort.
- `POST …/start`.
- `POST …/close` with `{ "reasonCode": "done", "note": "…" }`.

**What the guard sees:** the unit, the building, the requester's first name, what they wrote and the photo.

---

## Push notifications

Category `safety` (in `GET /me/notification-preferences`). Params are a type, a kind, minutes or a reason's code at most: **never a name or a unit on the lock screen.** The push's data carries the target's id.

| Kind | To | Target | Params | Critical |
|---|---|---|---|---|
| `emergency.reported` | guards on shift and responders | `emergency` | `emergencyType` | yes |
| `emergency.family_alert` | the others who live in the unit | `emergency` | — | yes |
| `emergency.responder_on_the_way` | the reporter and the family | `emergency` | `etaMinutes` | yes |
| `emergency.cancelled` | the responder (or those who would answer) | `emergency` | — | yes |
| `emergency.escalated` | the management | `emergency` | `emergencyType` | yes |
| `gate_service.requested` | guards on shift and handlers | `gate_service_request` | `serviceKind` | yes |
| `gate_service.accepted` | the requester | `gate_service_request` | `serviceKind`, `etaMinutes`? | no |
| `gate_service.closed` | the requester | `gate_service_request` | `serviceKind`, `reason` | no |

The residents' lock-screen texts:

| Kind | English | Arabic |
|---|---|---|
| `emergency.family_alert` | Emergency reported from your unit | تم الإبلاغ عن حالة طارئة من وحدتك |
| `emergency.responder_on_the_way` | A responder is on the way, about {etaMinutes} minutes. | أحد المستجيبين في الطريق، خلال {etaMinutes} دقائق تقريبًا. |
| `gate_service.accepted` | Security accepted your request and is on it. | قبل الأمن طلبك ويعمل عليه. |
| `gate_service.closed` | Security closed your request. The details are in the app. | أغلق الأمن طلبك. التفاصيل في التطبيق. |

---

## Value lists

| List | Values |
|---|---|
| `EmergencyType` | `medical`, `fire`, `security`, `facilities` |
| `EmergencyStatus` | `reported` (waiting for a responder), `on_the_way`, `arrived`, `resolved`, `cancelled` |
| `EmergencyTimelineStep` | `reported`, `security_notified`, `management_notified`, `on_the_way`, `arrived`, `family_on_the_way`, `resolved`, `cancelled` |
| `emergencyCancel` | `false_alarm`, `resolved_ourselves`, `other` |
| `emergencyResolve` | `handled`, `false_alarm`, `transferred_ambulance`, `transferred_civil_defense`, `other` |
| ETA minutes | `2`, `5`, `10`, `15` |
| `GateServiceKind` | `accessibility`, `suspicious`, `escort`, `lane` |
| `GateServiceStatus` | `open`, `accepted`, `in_progress`, `closed`, `cancelled` |
| `AssistanceKind` | `wheelchair`, `walk_with`, `golf_cart`, `bags` |
| `GateServiceWhen` | `now`, `in_15`, `in_30` |
| `LaneReason` | `ambulance`, `fire_truck`, `moving_truck`, `large_delivery` |
| `gateServiceClose` | `done`, `not_found`, `no_show`, `duplicate`, `not_possible` |
| `PlaceKey` | `main_gate`, `north_gate`, `phase_a`, `phase_b`, `clubhouse`, `parking`, `other` (or null) |
| Emergency contact roles | family: `owner`, `tenant`, `member`; gates: `gate`; management: `office`, `duty`, `emergency` |

---

## Errors

| Code | When |
|---|---|
| `UNIT_NOT_FOUND` (404) | the unit is not the caller's |
| `EMERGENCY_NOT_FOUND` (404) | unknown, or not the caller's to see |
| `EMERGENCY_CLOSED` (409) | resolved or cancelled (`params.status`) |
| `EMERGENCY_ACTION_NOT_ALLOWED` (403) | cancel by someone who is neither the reporter nor the primary; "on my way" by the reporter |
| `GATE_SERVICE_NOT_ALLOWED` (403) | the caller does not live in the unit |
| `GATE_SERVICE_LIMIT_REACHED` (409) | `params.max`, `params.scope` (`open` or `day`) |
| `GATE_SERVICE_NOT_FOUND` (404) | unknown, or not the caller's |
| `GATE_SERVICE_NOT_OPEN` (409) | security accepted it already (`params.status`) |
| `PLACE_NOT_FOUND` (404) | unknown or retired place (`params.field`) |
| `HOUSEHOLD_MEMBER_NOT_FOUND` (404) | `memberId` is not an active member of the unit's household |
| `GATE_NOT_FOUND` (404) | the lane's gate is unknown or out of service |

---

## Where we differ from your contract

- **`unitId` on every gate service request** (C7, D1–D3): a resident may live in several units, and the limits and who is told are per unit.
- **Places are ids:** `place`, `from` and `to` are `placeId`, `fromPlaceId` and `toPlaceId`, from `GET /community/places`.
  - `toPlaceId: null` (or omitted) means "to the unit" for accessibility help (your `"to": "unit"`).
  - A place in the answers is `{ id, key, nameEn, nameAr }`.
- **Uploads:** `photoUploadId` is `photoFileId`, as everywhere in the API.
- **`memberId`** is a household member's id (`GET /units/{unitId}/household`), or null for the caller.
- **References** are `E-0042`, `A-0007`, `S-0012`: the compound's own numbers, padded to four digits and growing past them, as every reference in the API (not six random digits).
- **A repeated emergency** of the same type from the same unit answers `200` with the open one instead of making another.
- **The responder** is `{ firstName, phone }`: a first name, and the phone of their gate (or the compound's duty phone), never their own.
- **`minutesAway`** comes from the minutes the responder picked when they accepted (no GPS). It is null until someone accepts, also on accessibility and escort requests.
- **The timeline** has more steps than `reported → security_notified → on_the_way → arrived`: also `management_notified`, `family_on_the_way` (one per member, with a first name) and `resolved`/`cancelled`. Steps are only there once they happened; there are no pending steps.
- **The family push** is generic: "Emergency reported from your unit", not "Mohamed reported a medical emergency at Building 7, Unit 12". The house rule is no names or units on a lock screen. The details are in the app.
- **`location`** is `{ unitId, unitCode, building }`.
- **Emergencies carry more:** `reportedBy` (first name), `familyOnTheWay`, `closeReason`, `onMyWay` (the caller's own answer) and `canCancel`.
- **Cancel** takes an optional `reasonCode`. Only the reporter or the unit's primary may cancel.
- **The family in C4** is only the people who live in the unit; a landlord gets none. A contact is `{ accountId, name, role, isPrimary, phone }` for the family, `{ gateId, name, role, phone }` for a gate, `{ role, phone }` for the management (no `name`: name it by role).
- **Lanes:** the body's `reason` comes back as `laneReason`, with the gate as `{ id, name }`.
- **Added:**
  - `GET /me/emergencies` (resume after a restart);
  - `GET /gate-services/{id}`;
  - `POST /gate-services/{id}/cancel`;
  - the requests' `when` and `wantedAt`;
  - `handler`;
  - `canCancel`.

---

## Not built

- The clinic (C5) and children's vaccinations (C6): hide those screens.
- A position or a map of the responder: there is no GPS; the minutes are the responder's word.
- A live channel (WebSocket or server-sent events): poll the emergency while its screen is open; pushes are the alarm.
- A push to the household when an emergency is resolved: they see it in the app.
- A push to a guard who starts a shift while an emergency is open: they see it in their queue, and the escalation to the management covers the gap.
- Incident reports and investigations (G6b).
