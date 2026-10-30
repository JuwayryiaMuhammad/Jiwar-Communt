# The guard's vendors: backend notes for the mobile team

What G8 built for the guard app and the resident app:
- a face check at the gate;
- an ID scan;
- a call from the gate to a household, in the app;
- a guard-down wearable paired for the shift;
- the control room (the dashboard's; the apps only feed it).

The design decisions are in [ADR 0068](../../decisions/0068-guard-vendors.md). The contract is `docs/api/openapi.v0.json`, with the Postman collection.

Conventions, as everywhere in API v0: every path under `/api/v1`, `Authorization: Bearer <access token>`, errors `{ statusCode, code, message, params?, fields? }` (switch on `code`), creates take an optional `Idempotency-Key`, instants ISO 8601 with an offset.

**Every vendor may be off.** A route that needs one answers `503 VENDOR_UNAVAILABLE {service}`, with `reason: 'off'` where this deployment has none (staging, for now). Say so and let the guard go on by hand; never retry in a loop.

## Face checks

Only where the compound turned them on (`409 FACE_CHECKS_OFF` otherwise), on shift at a gate.

1. Upload the photo as a `gate_face_probe` file (`POST /files/uploads`, then finalize).
2. `POST /gate/face-checks { photoFileId }` (an `Idempotency-Key`): `{ id, outcome, checkedAt, matches }`.
   - `possible_match`: show `matches` as the blocklist shows them (kind, name, face). Advisory: the guard compares the face; nobody is refused by it alone.
   - `no_match`; `unavailable` (the vendor failed: go on by hand).
   - Never a score.
3. `GET /gate/face-checks/{id}`: the guard's own.

## ID scans

On shift at a gate. Upload the document's photo as a `gate_id_scan` file, then `POST /gate/id-scans { imageFileId }` (no-store):

```json
{
  "documentType": "national_id",
  "number": "29001011234567",
  "names": { "en": "…", "ar": "…" },
  "birthDate": "1990-01-01",
  "expiresOn": "2030-01-01",
  "expired": false,
  "nationalId": { "valid": true, "birthDate": "1990-01-01" },
  "matches": []
}
```

- Fill the gate request with it; keep nothing. The server keeps nothing either, and deletes the image whatever came of it.
- `matches`: the blocklist's live entries for the number, as an ID lookup shows them.
- `422 ID_SCAN_UNREADABLE`: ask the guard to type the number (`POST /gate/id-lookup`).

## Calls from the gate

**The guard:**
- `POST /gate/calls { unitId, reasonCode, approvalRequestId? }` (an `Idempotency-Key`; `reasonCode` from `gateCallReason`): `{ id, unitCode, status: 'ringing', answered: false, … }`. `409 GATE_CALL_LIVE {callId}` (one live call a guard and a unit), `409 GATE_CALL_NO_HOUSEHOLD`.
- `POST /gate/calls/{id}/join`: `{ token, expiresAt }` (no-store) for the vendor's SDK. `409 GATE_CALL_NOT_READY`: ask again in a moment.
- `GET /gate/calls/{id}`: poll for `status` and `answered` — never who answered.
- `POST /gate/calls/{id}/end`.

**The household:**
- Push `gate.call_incoming` (critical): `{ gateName, reason }`, target the call. Ring.
- `GET /me/gate-calls/{id}`: `{ gateName, reasonCode, approvalRequestId, status, answeredByMe }`.
- `POST /me/gate-calls/{id}/answer`: `{ call, join: { token, expiresAt } }` (no-store). `409 GATE_CALL_ANSWERED`: someone else took it — stop ringing. Answered by you, ask again for a fresh token.
- `POST …/decline` (ends it for everyone), `POST …/end` (the one who answered).
- Statuses: `ringing`, `answered`, `declined`, `missed` (rang 45 s by default), `ended` (`endReason`: `guard`, `resident`, `max_duration`, `shift_ended`, `vendor`, `unavailable`). `409 GATE_CALL_ENDED {status}` on a call that is over.

## Guard-down wearables

- The management registers them on the dashboard.
- On shift (a gate or a zone): `POST /gate/alarm-devices/pair { deviceId }` → `{ id, label, shiftId, pairedAt }`; `POST /gate/alarm-devices/unpair` (204). The pairing ends with the shift. `409 ALARM_DEVICE_RETIRED`.
- The wearable talks to the server through its vendor: a fall, stillness or panic raises the guard's SOS from their post, exactly as their own SOS button does (the guard is not told of it; the other guards and responders are).

## The control room

The dashboard's (`control_room.watch`). The apps feed it by what they already do.
