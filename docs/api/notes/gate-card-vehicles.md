# Gate card — Vehicles & parking: backend notes for the mobile team

What was built for the resident app's Gate card, part B (vehicles, parking, fines, parking reports), and the guard's side of it.
- The design decisions are in [ADR 0045](../../decisions/0045-vehicles-and-parking.md).
- The contract is `docs/api/openapi.v0.json` (regenerated) and the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`.
- Lists are `{ "data": [...], "nextCursor": string | null }`; pass `nextCursor` back as `?cursor=`.
- Errors are `{ "statusCode", "code", "message", "params"?, "fields"?: [{ "field", "code", "params"? }], "requestId", ... }`. Switch on `code` and `fields[].code`, never on `message`.
- Creates take an optional `Idempotency-Key` header (a UUID): a retry with the same key answers the same, once.
- **Every response here is `Cache-Control: no-store`**: they carry plates, names and presigned photo URLs. Do not cache them on the device.
- Photo URLs are presigned and valid for a few minutes (`S3_URL_TTL_SECONDS`). Show them right away; read the resource again for a fresh one.
- Days are the compound's local days, `YYYY-MM-DD`. Instants are ISO 8601 UTC.
- Money is a decimal string with two decimals, in EGP (`"500.00"`).

## Contents

1. [Vehicles](#vehicles)
2. [B3 — editing a vehicle (answer)](#b3--editing-a-vehicle-answer)
3. [The unit's parking](#the-units-parking)
4. [Visitor parking bookings](#visitor-parking-bookings)
5. [Fines and their appeal](#fines-and-their-appeal)
6. [B6 — paying a fine (answer)](#b6--paying-a-fine-answer)
7. [Parking reports](#parking-reports)
8. [The guard](#the-guard)
9. [Push notifications](#push-notifications)
10. [Value lists](#value-lists)
11. [Where we differ from your contract](#where-we-differ-from-your-contract)
12. [Not built](#not-built)

---

## Vehicles

**Who:** someone who lives in the unit, or an adult household member with an account, with no grant from the primary needed.
- This is the capability `vehicles` in `GET /me/units/{unitId}/capabilities`. Show the Vehicles screen only when it is `true`.
- A landlord gets `403 VEHICLES_NOT_ALLOWED`. Another unit gets `404 UNIT_NOT_FOUND`.
- Everyone with the capability sees all the unit's vehicles.
- Only the vehicle's registrant or the unit's primary edits or removes it (`403 VEHICLE_ACTION_NOT_ALLOWED`). `canManage` on each vehicle tells you whether to show Edit and Remove.

### `GET /units/{unitId}/vehicles` → `200`

Bounded (`nextCursor` is always null). Removed vehicles are gone.

```json
{
  "data": [
    {
      "id": "01a13e8e-0ced-704d-ab63-b59b7aaa8b06",
      "reference": "V-2048",
      "plate": "ق ب ط ١٢٣٤",
      "makeAndModel": "Hyundai Elantra",
      "color": "Silver",
      "type": "car",
      "permitStatus": "expires_soon",
      "permitValidUntil": "2026-11-10",
      "stickerNumber": "B-0417",
      "rejectionReason": null,
      "licencePhotoUrl": "https://…/files/…?X-Amz-Signature=…",
      "canManage": true,
      "createdAt": "2026-10-15T09:12:44.120Z"
    }
  ],
  "nextCursor": null
}
```

- `permitStatus`:
  - `pending`: waits for the management;
  - `active`;
  - `expires_soon`: its last day is within 30 days;
  - `expired`: after its last day;
  - `rejected`: see `rejectionReason`.

  `expires_soon` and `expired` are worked out when you ask, never stored.
- `permitValidUntil` is the permit's **last valid day** (local). `stickerNumber` is set while `active` (including `expires_soon`/`expired`).

### `POST /units/{unitId}/vehicles` → `201`

With an optional `Idempotency-Key` header.

```json
{
  "plate": "ق ب ط ١٢٣٤",
  "makeAndModel": "Hyundai Elantra",
  "color": "Silver",
  "type": "car",
  "licencePhotoFileId": "01a13e8e-0b11-7a2c-9f00-5d1c0e2b7a41"
}
```

The answer is the vehicle, as in the list, `permitStatus: "pending"`.

- **The plate** takes the same format as a visitor's (ADR 0043): Arabic letters, Latin letters, Western or Arabic-Indic digits, and spaces. It is tidied (trimmed, single spaces, Latin upper-cased) and is at most 12 characters after that.
  - Otherwise `400`, field `plate`, `INVALID_FORMAT`, `params.maxLength: 12`.
  - The plate is shown back as typed, tidied.
- `makeAndModel` is 1–60 characters, `color` 1–30 (`INVALID_LENGTH`). `type` is `car | motorcycle | van`.
- **The licence photo** is optional. Upload it first, the 3-step way you upload any file:
  - `POST /files/uploads` with `{ "purpose": "vehicle_licence", "contentType": "image/jpeg" | "image/png" | "image/webp" | "application/pdf", "size": <bytes ≤ 10 MB> }`;
  - PUT the bytes to the returned URL with the returned headers;
  - `POST /files/{id}/finalize`;
  - then send the id as `licencePhotoFileId`.

  A file that is not your finalized `vehicle_licence` upload gets field `licencePhotoFileId`, `FILE_NOT_AVAILABLE`.
- **The limit:** at most 4 pending or active vehicles per unit (the compound's setting) gives `409 VEHICLE_LIMIT_REACHED`, `params.max`.

### `GET /vehicles/{id}` → `200`

One vehicle, as in the list. Another unit's vehicle, or a removed one, is `404 VEHICLE_NOT_FOUND`.

### `PATCH /vehicles/{id}` → `200`

Any of `plate`, `makeAndModel`, `color`, `type` and `licencePhotoFileId`:
- a new `licencePhotoFileId` replaces the photo;
- `null` removes the photo.

The answer is the vehicle. See [B3](#b3--editing-a-vehicle-answer) for what a plate change does.

### `DELETE /vehicles/{id}` → `204`

- **The reason** is an optional query `?reasonCode=` from `vehicleRemove` (default `other`).
- **Effect:** removal is final. The sticker and permit are void, the vehicle disappears from the list, and its licence photo is deleted 30 days later.
- **Nothing to restore:** to bring a car back, register it again.

### When the registrant leaves

When the person who registered a vehicle no longer lives in the unit (they moved out, were removed from the household, or their account was deactivated or deleted):
- the vehicles they registered there are removed by the system;
- the unit's primary gets the push `vehicle.registrant_left`, so a car that stays can be registered again.

---

## B3 — editing a vehicle (answer)

- **A new plate sends the vehicle back to `pending`.** Its sticker is void and never issued again, its permit is gone (`permitValidUntil: null`, `stickerNumber: null`), and the management decides again.
  - A plate that is the same plate typed differently (spaces, Arabic-Indic vs Western digits, `أ`/`إ`/`آ` vs `ا`, `ى` vs `ي`, `ة` vs `ه`) is not a new plate and changes nothing.
- **Colour, make and model, type and the licence photo keep the status.** An `active` vehicle stays `active` with its sticker.
- **A rejected vehicle** with a new plate waits again (`pending`), within the unit's limit. Without a new plate it stays `rejected`.

---

## The unit's parking

### `GET /units/{unitId}/parking` → `200`

For any member of the unit.

```json
{
  "slots": [{ "code": "B2-117", "place": "Basement 2, row C" }],
  "visitorAreas": [
    { "id": "01a13e8e-1b2c-7d3e-8f40-0a1b2c3d4e5f", "name": "Visitor area B", "freeSpaces": 3 }
  ]
}
```

- `slots` are the unit's own, given by the management.
- `visitorAreas` are the compound's active areas. `freeSpaces` is **now's**: spaces not held by a booking at this instant, never below zero. A booking later today may still be refused if the area is full then.

---

## Visitor parking bookings

**Who:** whoever may invite visitors to the unit (the `visitorsInvite` capability).
- The primary sees every booking of the unit; anyone else sees their own.
- The visitor's name shows to the one who booked only (`mine: true`).

### `POST /units/{unitId}/visitor-parking-bookings` → `201`

With an optional `Idempotency-Key` header. Book for a visitor pass:

```json
{
  "areaId": "01a13e8e-1b2c-7d3e-8f40-0a1b2c3d4e5f",
  "visitorPassId": "01a13e8e-2c3d-7e4f-9051-1b2c3d4e5f60",
  "startsAt": "2026-10-16T14:00:00.000Z",
  "endsAt": "2026-10-16T18:00:00.000Z"
}
```

or for a visitor's name:

```json
{
  "areaId": "01a13e8e-1b2c-7d3e-8f40-0a1b2c3d4e5f",
  "visitorPassId": null,
  "visitorName": "Mona Ali",
  "startsAt": "2026-10-16T14:00:00.000Z",
  "endsAt": "2026-10-16T18:00:00.000Z"
}
```

```json
{
  "id": "01a13e8e-3d4e-7f50-a162-2c3d4e5f6071",
  "reference": "P-8741",
  "areaId": "01a13e8e-1b2c-7d3e-8f40-0a1b2c3d4e5f",
  "areaName": "Visitor area B",
  "visitorPassId": null,
  "visitorName": "Mona Ali",
  "startsAt": "2026-10-16T14:00:00.000Z",
  "endsAt": "2026-10-16T18:00:00.000Z",
  "status": "confirmed",
  "cancelSide": null,
  "cancelReason": null,
  "mine": true,
  "createdAt": "2026-10-15T09:30:02.481Z"
}
```

**Rules** (each a field error on the field named):

- Whole minutes only (`INVALID_FORMAT`). `endsAt` is after `startsAt` (`ENDS_BEFORE_START`).
- **Timing:**
  - it starts no earlier than 15 minutes ago (`PARKING_TOO_EARLY`, `params.minutes`) and at most 14 days ahead (`PARKING_TOO_FAR`, `params.days`);
  - it lasts at least 15 minutes (`PARKING_TOO_SHORT`) and at most the compound's limit, 12 hours by default (`PARKING_TOO_LONG`, `params.hours`).
- **The pass:** one of the unit's, active, that you manage (you made it, or you are the unit's primary), else `visitorPassId`, `PASS_NOT_AVAILABLE`.
  - The window must lie inside the pass's validity (`startsAt`, `PARKING_OUTSIDE_PASS`, `params.validFrom`/`validUntil`).
  - With a pass, do not send `visitorName` (`FIELD_NOT_ALLOWED`); without one it is required (`FIELD_REQUIRED`, 1–80 characters).
- An area that is not active gives `areaId`, `AREA_NOT_AVAILABLE`.

**Refusals:**

- `409 VISITOR_PARKING_FULL`: no space free for **the whole** window. The area never holds more cars at one instant than its spaces; windows that never overlap both fit.
- `409 VISITOR_PARKING_LIMIT_REACHED` (`params.max`): the unit holds as many bookings not yet ended as the compound allows (3 by default).
- `403 VISITOR_PARKING_NOT_ALLOWED`: you may not invite visitors to this unit.

### `GET /units/{unitId}/visitor-parking-bookings?status=upcoming|past` → `200`

- `upcoming` (default): confirmed and not ended, soonest first.
- `past`: ended or cancelled, latest first.

Cursor-paged.

### `DELETE /units/{unitId}/visitor-parking-bookings/{id}` → `204`

- **Who:** the booker or the unit's primary, until it ends.
- **Already cancelled:** `409 VISITOR_PARKING_INVALID_TRANSITION`.
- **Ended:** `409 VISITOR_PARKING_WINDOW_PASSED`.

**Cancelled by someone else:**
- **Cancelling the pass** cancels its parking bookings that have not ended (`cancelSide: "system"`, `cancelReason: "pass_cancelled"`).
- **The management** may cancel one with a reason (`cancelSide: "staff"`).
- **A booker who leaves the unit** loses theirs (`booker_left`).

**The visitor's name** is deleted 30 days after the booking ends (`visitorName: null`).

---

## Fines and their appeal

**Who sees them:** the unit's vehicle keepers (`vehicles`) and whoever sees its money (`financeView`); anyone else gets `403 FINES_NOT_ALLOWED`.
- **Who appeals:** a vehicle keeper or the primary (`403 FINE_APPEAL_NOT_ALLOWED`). `canAppeal` tells you whether to show the button.
- **Never the source:** a fine never says where it came from: never a parking report, never who reported.

### `GET /units/{unitId}/vehicle-fines?status=unpaid|paid|cancelled` → `200`

Newest first, cursor-paged.
- `unpaid` includes fines under appeal.
- No `status` lists every fine.

```json
{
  "data": [
    {
      "id": "01a13e8e-4e5f-7061-b273-3d4e5f607182",
      "reference": "F-0042",
      "reason": "parked_in_visitor_slot",
      "date": "2026-10-14",
      "plate": "ق ب ط ١٢٣٤",
      "amount": "500.00",
      "currency": "EGP",
      "status": "under_appeal",
      "note": "Left in visitor area B overnight",
      "photoUrl": "https://…",
      "appeal": {
        "reason": "The car was a visitor's, with a pass.",
        "photoUrl": null,
        "appealedAt": "2026-10-15T08:01:12.000Z",
        "decision": null,
        "decidedAt": null
      },
      "cancelReason": null,
      "canAppeal": false,
      "createdAt": "2026-10-14T20:15:00.000Z"
    }
  ],
  "nextCursor": null
}
```

- `status`: `unpaid | under_appeal | paid | cancelled`.
- `reason` is a code (`vehicleFineReason`); show your own label.
- `note` is the management's words for the unit.
- `appeal` is null until appealed. `appeal.reason` is null if the appellant's account was deleted. `decision` is `upheld` (the fine stands, unpaid again) or `cancelled` (the fine is cancelled, see `cancelReason`).

### `GET /vehicle-fines/{id}` → `200`

One fine, as in the list (the push notifications target it). A fine of a unit whose fines you don't see is `404 VEHICLE_FINE_NOT_FOUND`.

### `POST /vehicle-fines/{id}/appeal` → `200`

```json
{ "reason": "The car was a visitor's, with a pass.", "photoFileId": "01a13e8e-…" }
```

- **`reason`:** your words, 1–1000 characters.
- **`photoFileId`:** optional, a finalized upload of purpose `parking_photo` (an image, 5 MB).
- **Once:** a second appeal, a paid fine or a cancelled one gives `409 FINE_APPEAL_CLOSED`.
- **Within 30 days** of the fine, else `409 FINE_APPEAL_WINDOW_PASSED` (`params.days`).
- **The answer** is the fine, `status: "under_appeal"`.
- **The decision:** the management upholds it or cancels the fine, and the appellant gets a push either way.

---

## B6 — paying a fine (answer)

**There is no payment gateway in this phase:**
- a fine is **paid at the management office**, in full;
- the accountant records the payment (receipt number, day paid) and the fine becomes `paid`;
- a payment recorded by mistake is reversed and the fine is `unpaid` again;
- **online payment comes with R6.**

Show "Pay at the management office" on an unpaid fine; there is nothing to call. A fine under appeal is paid once the appeal is decided.

---

## Parking reports

**Who:** anyone who lives in or belongs to a unit (`parking.report`).

### `POST /parking-reports` → `201`

With an optional `Idempotency-Key` header.

```json
{ "plate": "ABC 123", "location": "Visitor area B, by the gym", "note": "Blocking two spaces since 9am", "photoFileId": "01a13e8e-…" }
```

```json
{
  "id": "01a13e8e-5f60-7172-c384-4e5f60718293",
  "reference": "R-3917",
  "plate": "ABC 123",
  "location": "Visitor area B, by the gym",
  "note": "Blocking two spaces since 9am",
  "status": "open",
  "createdAt": "2026-10-15T09:41:20.007Z"
}
```

- **The fields:** `plate` takes the vehicle format; `location` is 1–120 characters; `note` 1–500; `photoFileId` is a `parking_photo` upload.
- **The answer is the same whether the plate matches a registered car or not.** We never tell the reporter whose car it is.
- **The limit:** at most 10 open reports per person (`409 PARKING_REPORT_LIMIT_REACHED`, `params.max`).

### `GET /parking-reports` → `200`

Your own reports, newest first, `status: "open" | "closed"`.
- `closed` means security dealt with it, whatever they did; you never learn the outcome.
- **The reported unit never learns who reported.** If security fines it, the fine says nothing of the report.

---

## The guard

All of these need `gate.operate` and an open shift (`403 NO_OPEN_SHIFT`).

### `POST /gate/plate-lookup` → `200`

The plate goes in a body, never in the URL. It shares the guard's rate limit with verify (`429 RATE_LIMITED`).

```json
{ "plate": "قبط 1234" }
```

```json
{
  "plate": "قبط 1234",
  "matches": [
    {
      "kind": "vehicle",
      "unitCode": "A-101",
      "plate": "ق ب ط ١٢٣٤",
      "vehicle": {
        "permitStatus": "active",
        "permitValidUntil": "2027-10-14",
        "stickerNumber": "B-0417",
        "type": "car",
        "color": "Silver",
        "makeAndModel": "Hyundai Elantra"
      },
      "pass": null
    },
    {
      "kind": "visitor_pass",
      "unitCode": "C-310",
      "plate": "ق ب ط 1234",
      "vehicle": null,
      "pass": {
        "passKind": "one_time",
        "valid": true,
        "refusal": null,
        "validFrom": "2026-10-15T08:00:00.000Z",
        "validUntil": "2026-10-15T20:00:00.000Z",
        "parking": {
          "areaName": "Visitor area B",
          "startsAt": "2026-10-15T09:00:00.000Z",
          "endsAt": "2026-10-15T13:00:00.000Z"
        }
      }
    }
  ]
}
```

- **Matching:** by the plate's key. Spaces, Arabic-Indic vs Western digits and the letter variants `أ`/`إ`/`آ`/`ا`, `ى`/`ي` and `ة`/`ه` do not matter (ADR 0047).
- **What comes back:** the units' **pending and active** vehicles (`permitStatus` read now, so an expired permit shows `expired`), and the **active** visitor passes carrying the plate that are valid within a day.
  - For a pass, `valid` says whether it lets its visitor in now, else `refusal` (`not_yet_valid | expired | outside_schedule | host_inactive | used | cancelled`).
  - `parking` is its booking holding now, or the next within two hours.
- **Never a name.** Unknown plates answer `"matches": []`.
- **Audited:** every lookup is audited on the guard's shift with what it found, never with the plate.

### `POST /gate/verify` (changed)

A valid visitor pass's `display` gains `parking`: `{ areaName, startsAt, endsAt }`, the booking holding now or the next within two hours, else null.

### `GET /gate/visitor-parking` → `200`

The visitor parking bookings holding now or starting within two hours, soonest first: `id`, `reference`, `unitCode`, `areaName`, `startsAt`, `endsAt`, `hasPass`, and `visitorName` for a booking **without** a pass (the only way to tell that visitor's car). A pass's booking shows on its verify.

---

## Push notifications

Category `vehicles` (in `GET /me/notification-preferences`). None is critical. Params are a reason's code at most; there is never a plate, a unit, an amount or a name on the lock screen.

| Kind | To | Target | Params |
| --- | --- | --- | --- |
| `vehicle.approved` | the registrant | `vehicle` | — |
| `vehicle.rejected` | the registrant | `vehicle` | `reason` (`vehicleReject`) |
| `vehicle.permit_expiring` | the registrant (or, if they left, the primary), once per last day, 30 days ahead | `vehicle` | — |
| `vehicle.registrant_left` | the unit's primary | `vehicle` | — |
| `vehicle_fine.issued` | the unit's vehicle keepers and its primary | `vehicle_fine` | `reason` (`vehicleFineReason`) |
| `vehicle_fine.appeal_upheld` | the appellant | `vehicle_fine` | — |
| `vehicle_fine.appeal_accepted` | the appellant | `vehicle_fine` | — |

A removed vehicle's target answers `404 VEHICLE_NOT_FOUND`; open the list instead.

---

## Value lists

| List | Values |
| --- | --- |
| `VehicleType` | `car`, `motorcycle`, `van` |
| `VehiclePermitStatus` | `pending`, `active`, `expires_soon`, `expired`, `rejected` (`removed` on the management's views only) |
| `vehicleReject` | `licence_missing`, `licence_unreadable`, `plate_mismatch`, `not_resident_vehicle`, `other` |
| `vehicleRemove` (yours, on DELETE) | `sold`, `no_longer_used`, `registered_in_error`, `other` |
| `VisitorParkingStatus` | `confirmed`, `cancelled` |
| `VisitorParkingCancelSide` | `resident`, `staff`, `system` |
| `cancelReason` (visitor parking) | `no_longer_needed` (resident), `area_closed`, `misuse`, `other` (staff), `pass_cancelled`, `booker_left` (system) |
| `VehicleFineStatus` | `unpaid`, `under_appeal`, `paid`, `cancelled` |
| `vehicleFineReason` | `parked_in_visitor_slot`, `parked_in_others_slot`, `blocking`, `no_permit`, `fire_lane`, `other` |
| `vehicleFineCancel` | `appeal_accepted`, `issued_in_error`, `duplicate`, `other` |
| `VehicleFineDecision` | `upheld`, `cancelled` |
| Report `status` (yours) | `open`, `closed` |
| File purposes | `vehicle_licence` (image or PDF, 10 MB), `parking_photo` (image, 5 MB) |

---

## Where we differ from your contract

- **Uploads:** `photoUploadId` is `photoFileId` (and the vehicle's licence is `licencePhotoFileId`), as everywhere in the API. Upload the 3-step way (`/files/uploads`, PUT, `/files/{id}/finalize`).
- **Vehicles:** they also carry `rejectionReason` (while rejected) and `canManage`.
- **`DELETE /vehicles/{id}`** takes an optional `?reasonCode=` (`vehicleRemove`, default `other`).
- **Bookings:** they also carry `areaName`, `cancelSide`, `cancelReason` and `mine`. Sending `visitorName` with a `visitorPassId` is refused (`FIELD_NOT_ALLOWED`).
- **Fines:**
  - they also carry `reference` (`F-0042`), `currency`, `note`, `photoUrl`, `appeal`, `cancelReason` and `canAppeal`;
  - `amount` is a decimal string;
  - `date` is the local day it happened;
  - `GET /vehicle-fines/{id}` is an addition;
  - `status=cancelled` is an extra filter, and `unpaid` includes `under_appeal`.
- **Reports:** `GET /parking-reports` (your own) is an addition.
- **References** are `V-`, `P-`, `F-`, `R-` with at least four digits, growing past them (`V-12345`).

---

## Not built

- Online payment of fines (R6) and partial payments; appeals to the board (R7).
- Replacing a lost sticker as such: a plate edit voids it, or the vehicle is removed and registered again.
- Service and delivery vehicles; plate-reading cameras.
- A notification when the management cancels a visitor parking booking (the household sees it cancelled).
- The reporter is never told what became of a report.
- Emergencies, gate services and the clinic (parts C–D) and later phases.
