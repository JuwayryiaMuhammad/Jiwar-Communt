# The gate offline: backend notes for the guard app and the management app

What was built so the gate keeps working without network:

- the guard's phone enrols as a gate device with its own Ed25519 key;
- on shift, it downloads a signed bundle of what it may decide alone, valid until the shift's planned end;
- offline, it decides from the bundle and records every action locally;
- back online, it uploads the actions in signed, ordered batches. The server records them at their device time, never refuses what happened, and flags what it knew better;
- the management watches each device's sync, reviews the flags, revokes a lost phone, and decides what a revoked phone uploaded.

The design decisions are in [ADR 0057](../../decisions/0057-guard-offline.md). The contract is `docs/api/openapi.v0.json` (regenerated) and the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`.
- Lists are `{ "data": [...], "nextCursor": string | null }`.
- Errors are `{ "statusCode", "code", "message", "params"?, "fields"?: [...] }`. Switch on `code` and `fields[].code`, never on `message`.
- **Every response here is `Cache-Control: no-store`.**
- **Every instant carries its offset, `Z` or `±HH:MM`** (RFC 3339): send UTC with milliseconds (`2026-11-06T09:00:00.000Z`). A time without one names no instant and is refused, never read in a zone: an envelope's `sentAt` is 422 `GATE_DEVICE_ENVELOPE_INVALID` (`params.reason: "sent_at"`), an action's `deviceTime` is `INVALID_FORMAT` in the upload's `fields` (ADR 0025).
- base64url is RFC 4648 §5, **without padding**.
- The device routes take **no `Idempotency-Key`**: the client ids, the batch id and the sequence numbers do that job.

## Contents

1. [What the app must implement](#what-the-app-must-implement)
2. [Keys and enrolment](#keys-and-enrolment)
3. [The signed envelope](#the-signed-envelope)
4. [The clock](#the-clock)
5. [The bundle](#the-bundle)
6. [Tags: matching without the values](#tags-matching-without-the-values)
7. [Deciding offline](#deciding-offline)
8. [Recording actions](#recording-actions)
9. [Uploading](#uploading)
10. [Heartbeat and refresh](#heartbeat-and-refresh)
11. [Revocation and quarantine](#revocation-and-quarantine)
12. [Test vectors](#test-vectors)
13. [The management app](#the-management-app)
14. [Push notifications](#push-notifications)
15. [Errors](#errors)

---

## What the app must implement

A checklist for the guard app. Each item is detailed below.

1. **Generate an Ed25519 key pair once per install**, in the platform's secure storage (iOS Keychain / Secure Enclave-wrapped; Android Keystore-backed encryption). The private key never leaves the device. Generate a UUIDv7 device id once with it.
2. **Enrol** with `POST /gate/devices` and a proof signed with the key.
3. **Sign every device call** (bundle, heartbeat, upload) as an envelope: the payload's JSON in base64url, and the signature over a label plus that string.
4. **Calibrate the clock** from every `serverTime` with a monotonic clock. Time every action by the calibrated clock, never by the wall clock.
5. **Download a bundle** when the shift opens, then whenever a heartbeat says `refreshBundle`, and before it expires. Verify its signature with the key of its `keyVersion` before using it.
6. **Keep the bundle in encrypted storage.** Delete it once it expires, at the guard's sign-out, and when the shift ends.
7. **Decide offline from the bundle only**, and never after `validUntil`. Show "offline unavailable: call the gate phone" instead.
8. **Record every action** with a new UUIDv7 `clientId` and the next `seq`, persisted before the guard sees the result.
9. **Upload in `seq` order** in batches of at most 100, each with a new `batchId`. Retry the same batch unchanged until it is answered. Forget what `ackedThroughSeq` covers.
10. **Send a heartbeat** every minute while online, with how many actions are still held.
11. **Handle revocation:** on 403 `GATE_DEVICE_REVOKED`, stop deciding offline, delete the bundle, and keep uploading what is held.

## Keys and enrolment

**The key.** Ed25519 (RFC 8032). The public key is sent as its raw 32 bytes in base64url: 43 characters, the same as a JWK's `x`. Signatures are 64 bytes in base64url: 86 characters.

**`POST /gate/devices`** (`gate.operate`; no shift needed):

```json
{
  "id": "<device UUIDv7>",
  "publicKey": "<43 chars>",
  "label": "Main gate phone",
  "proof": "<86 chars>"
}
```

- `label` is optional, 1–40 characters.
- `proof` is the signature of this UTF-8 string, with `\n` as line feeds:

  ```
  jiwar:gate-device-enroll:v1
  <tenantId>
  <deviceId>
  <publicKey>
  ```

  `tenantId` is the compound's id from the session.

**The answer** is 201 `{ id, status, enrolledAt, serverTime }`.

- Sending the same id and key again answers the same (a safe retry).
- **Another key under the same id** is 409 `GATE_DEVICE_EXISTS`. Generate a new id with a new key.
- **The same key under another id** is 409 `DUPLICATE_RESOURCE` (`fields: [{field: "publicKey"}]`).
- **50 live devices** in the compound is 409 `GATE_DEVICE_LIMIT_REACHED` (`params.max`).
- **A bad proof** is 422 `GATE_DEVICE_SIGNATURE_INVALID`.

The management is told of every enrolment. A reinstall means a new key and a new device. The management revokes the old one.

## The signed envelope

`POST /gate/offline/bundles`, `/heartbeat` and `/uploads` all take the same body:

```json
{ "deviceId": "<uuid>", "payload": "<base64url of UTF-8 JSON>", "signature": "<86 chars>" }
```

- **`signature`** is Ed25519 over the UTF-8 bytes of `jiwar:gate-device:v1\n` followed by **the `payload` string exactly as sent**. Sign the string you send. Never re-serialise it: the server verifies the string as received, so no canonical JSON is needed.
- **The payload is a JSON object** with these fields, plus the call's own:

| Field | |
|---|---|
| `purpose` | `bundle`, `heartbeat` or `upload` |
| `tenantId` | The compound's id |
| `deviceId` | The same as outside the payload |
| `sentAt` | The calibrated clock when signing |

- **`payload`** is at most 96,000 characters.
- **The bearer token is required too.** The envelope proves the device, the token the guard.

**Replay protection.** A bundle or heartbeat envelope is accepted once: sending the same one again is 409 `GATE_DEVICE_ENVELOPE_REPLAYED`. **To retry a bundle or a heartbeat, build a new envelope** with a new `sentAt`. An upload envelope may be resent unchanged (see [Uploading](#uploading)).

**Freshness.** `sentAt` must be within 24 hours of the server's clock, either way, or the call is 422 `GATE_DEVICE_ENVELOPE_INVALID` with `params.reason: "sent_at"`. There is no tighter window. A wrong clock is corrected by calibration, and flagged, never refused.

## The clock

Every response a device reads carries **`serverTime`**: enrolment, keys, bundle, upload, heartbeat. The app keeps an offset:

```
on each response:  offset = serverTime − (monotonicNow at receipt − rtt/2)
calibrated now   = monotonicNow + offset
```

- **`monotonicNow`** is a clock that does not jump: `SystemClock.elapsedRealtime()` on Android, `clock_gettime(CLOCK_MONOTONIC_RAW)` or `ProcessInfo.systemUptime` on iOS. Keep the last offset across restarts with the boot id. After a reboot, use the wall clock until the next `serverTime`.
- **Time every action and `sentAt`** by the calibrated clock. The guard changing the phone's time must not change them.
- **What the server does with a wrong time:**
  - an action's time is clamped to [the bundle's `issuedAt` − 2 min, the upload's receipt];
  - a clamped time, or one more than 2 minutes before the previous `seq`'s, is flagged `clock_skew`;
  - a batch whose `sentAt` is more than 2 minutes off the server's clock is flagged once.

  Nothing is refused for its time.

## The bundle

**`GET /gate/offline/keys`** (`gate.operate`) answers `{ keys: [{version, publicKey, current}], serverTime }`. Cache the keys. Fetch them again when a bundle names a `keyVersion` you do not have. A retired key stays listed for a day after a rotation.

**`POST /gate/offline/bundles`** takes an envelope with `purpose: "bundle"` and nothing else. It needs an open shift at a gate (403 `NO_OPEN_SHIFT`). It answers:

```json
{ "keyVersion": 1, "body": "<base64url>", "signature": "<86 chars>", "serverTime": "…" }
```

1. **Verify** Ed25519 over `jiwar:gate-bundle:v1\n<body>` with the key of `keyVersion`. Refuse a bundle that does not verify.
2. **Decode** `body` (base64url → UTF-8 → JSON).
3. **Check** that `v` is 1, that `tenantId` and `deviceId` are yours, and that `version` is higher than the one you hold.
4. **Replace** the old bundle with it.

At most 4 a minute per device (429 `RATE_LIMITED`). A revoked device is 403 `GATE_DEVICE_REVOKED`.

**The header:**

| Field | |
|---|---|
| `v` | 1 |
| `bundleId` | The bundle's id; the tags of long values use it |
| `tenantId`, `deviceId`, `gateId`, `shiftId`, `guardId` | Whose it is |
| `version` | Monotonic per device |
| `issuedAt`, `validUntil` | Its window: never decide outside it |
| `keyVersion` | The key it is signed with |
| `timezone` | The compound's IANA zone, for schedules and work hours |
| `salt` | 32 bytes in base64url: the key of the short tags |

**The sections** (field by field in ADR 0057, section 3):

| Section | Items |
|---|---|
| `lockdown` | `{scope: "gate" \| "all", since}` or null: the gate was locked at download |
| `passes[]` | `{ref, unitCode, kind, partySize, entriesUsed, inside, validFrom, validUntil, schedule, code, qr, plate}` |
| `workers[]` | `{ref, unitCode, capacity, validUntil, schedule, inside, code, qr}` |
| `blocklist[]` | `{ref, kind: "ban" \| "watch", plate}` |
| `residents[]` | Credential tags |
| `workRules` | The compound's work days and hours for contractors and moves (ADR 0049) |
| `works[]` | `{ref, reference, unitCode, startsAt, endsAt, dailyFrom, dailyTo, stopped, workers}` |
| `moves[]` | `{ref, reference, unitCode, startsAt, endsAt, plate}` |
| `events[]` | `{ref, reference, unitCode, guestsFrom, guestsUntil, guests: [{ref, name, plate}]}` |
| `serviceVehicles[]` | `{ref, plate, kind}`: inside at download |
| `children[]` | `{ref, card, mayLeaveAlone, adults: [{ref, credentials[], validFrom, validUntil, schedule, gateId, placeId}]}` |

- **`code`, `qr`, `plate`, `name`, `card` and `credentials` are tags**, never the values. Every `ref` is the id to upload.
- **Schedules** are the same weekly windows as online, in `timezone`.
- **A pass's `entriesUsed` and `inside`, and a worker's `inside`,** are as at download. Count your own actions on top of them.

**Lifetime.** `validUntil` is the shift's planned end plus 30 minutes, at most 24 hours after issue. It is 12 hours for an unscheduled shift, and 1 hour in overtime.

## Tags: matching without the values

Every tag is the first 16 bytes of a hash, in base64url (22 characters).

**Short values** (keyed with the bundle's salt):

```
tag = base64url( HMAC-SHA256(key = salt, msg = "<kind>:<value>")[0:16] )
```

| Kind | Value |
|---|---|
| `visitor-code` | The 6 digits typed |
| `worker-code` | The 8 digits typed |
| `plate` | The plate key (below) |
| `guest-name` | The name key (below) |

**Long values** (labelled with the bundle's id):

```
tag = base64url( SHA-256("jiwar:offline:v1:<kind>:<bundleId>:<value>")[0:16] )
```

| Kind | Value |
|---|---|
| `visitor-qr` | The token after `JWR1.` in a pass's QR |
| `worker-qr` | The token after `JWR1.` in a worker's card |
| `resident-credential` | The credential id in a `JWR2.<id>.<step>.<mac>` QR |
| `child-card` | The lowercase hex SHA-256 of `jiwar:child-card:v1:<tenantId>:<token>`, where `token` is the part after `JWC1.` (ADR 0054) |

**The plate key** must fold exactly like the server's:

1. trim, make every run of whitespace one space, upper-case Latin letters;
2. the plate must then be 1–12 characters of `A–Z`, `0–9`, Arabic letters, Arabic-Indic digits and spaces;
3. remove the spaces;
4. map each of `٠١٢٣٤٥٦٧٨٩أإآىة` to the character at the same place in `0123456789ااايه`.

So `ق ب ط ١٢٣٤` and `قبط1234` are one key.

**The name key** (a guest's full name, as typed from their ID):

1. map `A–Z` to `a–z`, and `أ إ آ` to `ا`, `ى` to `ي`, `ة` to `ه`;
2. remove U+064B–U+0652 (the short vowels and shadda) and U+0640 (tatweel);
3. make every run of spaces, tabs and line ends one space, and trim.

Do not lower-case by locale. An empty result matches nothing.

A pass's QR and a worker's card share the prefix `JWR1.`: compute both the `visitor-qr` and the `worker-qr` tag of the token and look in both sections.

A tag matches when it is equal to an item's. Compare in constant time.

**Security.** Whoever extracts a bundle and its salt can try every 6- or 8-digit code, and every common name, against its tags. That is inherent to checking without the server. It is bounded by:

- the bundle's validity: delete it once expired;
- revocation;
- **the device's secure storage**: never write the bundle or the key to plain files, logs, backups or crash reports.

## Deciding offline

**Use the bundle's sections only, at the calibrated time, inside `[issuedAt, validUntil]`.**

**A locked gate.** With `lockdown` not null, nobody comes in: every `in` is refused on the device. Exits always go out. A lockdown that starts while offline is unknown to the device. Entries during it are recorded at sync, flagged, and the guards on shift are told.

| Who | Offline | Refuse on the device when |
|---|---|---|
| **Visitor** (`passes`) | Code, QR or the visitor's plate | Outside `validFrom`–`validUntil` or the schedule; a one-time pass with `entriesUsed` (plus yours) at `partySize`; a recurring pass with `inside` (plus yours) at `partySize`; a banned plate |
| **Worker** (`workers`) | Code or card | Outside the schedule (empty = any time, live-in); past `validUntil` |
| **Move truck** (`moves`) | Plate | Outside `startsAt`–`endsAt`, or outside the compound's `workRules` |
| **Event guest** (`events`) | Plate, or the exact name from their ID | Outside `guestsFrom`–`guestsUntil` |
| **Contractor** (`works`) | The permit's `reference` typed, then the ID's last four (matched at sync) | `stopped`; outside its window, its `dailyFrom`/`dailyTo` (minutes after midnight in `timezone`) or `workRules` |
| **Service vehicle** | In: as online. Out: by plate | A banned plate (`blocklist`, `kind: "ban"`) |
| **Material entry** | As online | During a lockdown |
| **Patrol scan** | On a run started online | As the run's rules on the device |
| **Child** (`children`) | Alone with `mayLeaveAlone`; a household adult whose QR's credential is in `adults[].credentials`, valid that day, hour and post, **with the ID checked** | Anyone else: hold the child |
| **Resident** (`residents`) | The QR's credential is known: show **"Resident — not verifiable offline: check ID"** | Unknown credential |

- **A watched plate** (`kind: "watch"`) lets the person in, and the server flags it at sync.
- **Never record a resident.** Residents are not logged online either.
- **Online only:** field exceptions, gate requests, approvals, standing instructions, lockdown start and end, overrides, SOS, worker and outside child escorts, pickup codes, ID lookups, blocklist persons, visitor photos, starting a patrol run, material exits. Offline, show "needs network".

## Recording actions

Every action the guard confirms is persisted locally **before** the result shows, with:

| Field | |
|---|---|
| `clientId` | A new UUIDv7. The entry's id at the server |
| `seq` | The device's next number: 1, 2, 3… for its whole life, never reused, never skipped on purpose |
| `deviceTime` | The calibrated clock when it happened |
| `bundleId` | The bundle it was decided with |
| `type` | One of the seven below |

**Online first, offline after.** If the app sent an action online (`POST /gate/entries {id}`) and lost the answer, record it offline **with the same id as `clientId`**. The server converges on one entry.

**Per type** (unknown fields are ignored; required ones are FIELD_REQUIRED / INVALID_VALUE / INVALID_FORMAT):

- **`entry`**: `{subjectType, subjectId, direction: "in" | "out", via}`.
  - `subjectType` is `visitor_pass`, `worker_engagement`, `event_guest` or `move_permit`.
  - `subjectId` is the item's `ref`. For an event guest it is the guest's `ref`; for a truck, the move's `ref`.
  - `via` is required on `in`: how the device knew them. `visitor_pass` takes `code`, `qr` or `plate`; `worker_engagement` takes `code` or `qr`; `event_guest` takes `plate` or `list` (the name); `move_permit` takes `plate`.
- **`contractor`**: `{permitId, direction, idLast4}`.
  - `permitId` is the works permit's `ref`.
  - `idLast4` is 4 characters `A–Z0–9`. The server finds the worker. Keep it only until the action is acknowledged.
- **`service_vehicle_in`**: `{plate, kind, company, unitCode?, facilityId?}`.
  - `kind` is `tanker`, `waste`, `delivery` or `other`.
  - `company` is 1–120 characters.
  - Give at most one of `unitCode` and `facilityId`.
- **`service_vehicle_out`**: `{plate}`. The visit inside with that plate closes. You may not know it, if another device let it in.
- **`material_entry`**: `{unitCode, permitId?, description}`. `description` is 1–280 characters.
- **`patrol_scan`**: `{runId, method: "qr" | "nfc" | "manual", payload | (checkpointId, reasonCode), lat?, lng?, accuracyM?}`.
  - `payload` is the checkpoint's scanned text.
  - `manual` takes `checkpointId` and a `reasonCode` from `patrolManualScan` instead.
  - `lat` and `lng` come together.
- **`child_exit`**: `{controlId, escort: "alone" | "adult" | "other", released, qr?, idChecked?}`.
  - `controlId` is the child's `ref`.
  - `qr` is the adult's full `JWR2.…` QR as scanned, required for `adult`.
  - **`released: true` with `adult` requires `idChecked: true`**: the guard attests they checked the adult's ID against the household. The app must ask for it explicitly, never by default.
  - **`other` is never released** (`released: false`).
  - A child held is recorded too: the household is told at sync.

## Uploading

**`POST /gate/offline/uploads`** (`gate.operate`; any guard may upload, with or without a shift). The envelope's payload is:

```json
{
  "purpose": "upload",
  "tenantId": "…",
  "deviceId": "…",
  "sentAt": "…",
  "batchId": "<new UUIDv7>",
  "actions": [ { "clientId": "…", "seq": 41, "deviceTime": "…", "bundleId": "…", "type": "entry", … } ]
}
```

- **1 to 100 actions, `seq` strictly increasing**, oldest first. Keep the body under 100 KB.
- **Upload in order:** never send `seq` 50 before 49 has been sent.
- **Retry a batch unchanged**, the same envelope or a new one with the same `batchId` and actions, until it is answered. A retried batch answers what it recorded.
- **Never put an action in two different batches with different content.**

**A whole batch is refused**, with nothing recorded, when:

| Answer | Why |
|---|---|
| 422 `GATE_DEVICE_SIGNATURE_INVALID` | The signature does not verify |
| 422 `GATE_DEVICE_ENVELOPE_INVALID` | The envelope says something else (`params.reason`) |
| 400 `VALIDATION_FAILED` | The payload does not parse. `fields[].field` is `payload.actions.<i>.<field>` or `payload.batchId` |
| 404 `GATE_DEVICE_NOT_FOUND` | The device is unknown here |

**Fix the cause; don't loop.** The management is told of refusals.

**The answer:**

```json
{
  "batchId": "…",
  "receivedAt": "…",
  "ackedThroughSeq": 41,
  "results": [ { "clientId": "…", "seq": 41, "status": "recorded", "reason": null, "flags": [], "entryId": "…" } ],
  "serverTime": "…"
}
```

**`status`:**

| Status | Meaning |
|---|---|
| `recorded` | Recorded now |
| `duplicate` | Recorded before (a retry) |
| `rejected` | Not recorded; see `reason` |
| `quarantined` | The device was revoked: the management decides |

**`reason`** (rejected only):

| Reason | Meaning |
|---|---|
| `bundle_unknown` | Not a bundle of this device |
| `subject_unknown` | The `ref` is unknown in the compound |
| `contractor_unresolved` | No worker of the permit, or more than one, has those last four |
| `patrol_refused` | The run refused the scan |
| `client_id_reused` | Another action holds the `clientId` |
| `sequence_reused` | Another action holds the `seq` |
| `quarantine_rejected` | The management rejected a revoked device's action |

- **`flags`** say what the server knew better (ADR 0057, section 7). The guard needs nothing more: the management reviews them.
- **`ackedThroughSeq`**: every action up to it was received. **Delete those from the device.** An action above it that you still hold was not received yet: resend it. A gap that never fills is shown to the management.

**The guard's confirmation.** Show the guard each batch's count of recorded and rejected actions. Keep a rejected action's summary on the device until the shift ends.

## Heartbeat and refresh

**`POST /gate/offline/heartbeat`**, every minute while online. The payload is `{purpose: "heartbeat", tenantId, deviceId, sentAt, pendingCount}`, where `pendingCount` is how many actions the device still holds (an integer ≥ 0). It answers:

```json
{ "serverTime": "…", "ackedThroughSeq": 41, "refreshBundle": true }
```

**`refreshBundle`** is true when the bundle is older than 15 minutes, or when a lockdown started or ended, or the blocklist changed, since it was issued. Then download a new bundle at once.

**Without a heartbeat answer**, refresh every 15 minutes while online, and on network return. Each retry is a new envelope.

The management is told when a device on shift with a valid bundle is silent for the compound's `offlineSyncAlertMinutes` (default 15). So heartbeat even when nothing is pending.

## Revocation and quarantine

- **A revoked device** gets 403 `GATE_DEVICE_REVOKED` on bundle and heartbeat. Then:
  - stop deciding offline;
  - delete the bundle;
  - tell the guard "this phone was revoked";
  - keep uploading what it holds.
- **Its uploads still succeed**, every action `quarantined`. Nothing is recorded until a manager accepts the batch: then each action is decided as at its receipt. Rejected, each stays rejected.
- **A contractor's last four are dropped from a quarantined action**, so an accepted contractor action is `contractor_unresolved`.
- **To use the phone again**, enrol a new key under a new device id.

## Test vectors

Reproduce these in the app's tests. They are pinned by the server's unit specs and computed independently (Python's `cryptography`).

**Device key** (RFC 8032 test 1):

- seed `nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A`
- public key `11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo`
- tenant `01a102b6-6253-74a0-92b1-96e7c9d52601`, device `01a102b6-6253-74a0-92b1-9d0f6c2e4a11`
- enrolment proof `r66MZZLmCrrpbGNDfUfh28yT4k-kXFtws__Rrm5mlTaUZNj3JRAGlncqQHar5fcPiii1fFyP_QewN4xLB7Y8AQ`

**A heartbeat envelope.** The JSON `{"purpose":"heartbeat","tenantId":"01a102b6-6253-74a0-92b1-96e7c9d52601","deviceId":"01a102b6-6253-74a0-92b1-9d0f6c2e4a11","sentAt":"2026-11-06T09:00:00.000Z","pendingCount":0}` gives:

- payload `eyJwdXJwb3NlIjoiaGVhcnRiZWF0IiwidGVuYW50SWQiOiIwMWExMDJiNi02MjUzLTc0YTAtOTJiMS05NmU3YzlkNTI2MDEiLCJkZXZpY2VJZCI6IjAxYTEwMmI2LTYyNTMtNzRhMC05MmIxLTlkMGY2YzJlNGExMSIsInNlbnRBdCI6IjIwMjYtMTEtMDZUMDk6MDA6MDAuMDAwWiIsInBlbmRpbmdDb3VudCI6MH0`
- signature `_p5YsEOLsEmn5m9NqKgGlcfi6LkvMcmYwXxWvtxB_i8MJf5yZ-twWDgF-y012Z7tR2xv5gmbsKRoYhtawF7oCw`

**A bundle signature** (RFC 8032 test 2):

- public key `PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw`
- body `eyJ2IjoxLCJidW5kbGVJZCI6IjAxYTEwMmI2LTYyNTMtNzRhMC05MmIxLWEwYzRlNWY2MDcxOCJ9`
- signature `adaLnWIbdvnfbZ_zoKpG8bJhIqsOcnuI5WaaZ6lJBXfow-oayieYpiZobg2ABJ_UG5SwGclkTnfL0ddlsk6bBg`

**Tags**, with salt `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8` (bytes 0–31) and bundle `01a102b6-6253-74a0-92b1-a0c4e5f60718`:

| Kind | Value | Tag |
|---|---|---|
| `visitor-code` | `482913` | `I3qtK8_tJZJFMXIDorsdCA` |
| `worker-code` | `07315528` | `jSC_IDKzOuLTrjGTa8BtpQ` |
| `plate` | `قبط1234` (from `ق ب ط ١٢٣٤`) | `oPM3-HUXHVf9hkZWL_nF1A` |
| `guest-name` | `مريم احمد` (from `مَريم  أحمد`) | `0aKVKqV3D3Lk8wOgCxcyag` |
| `visitor-qr` | `q3Jzx8b7m2Kd9PwS0aLr5TnYc4Ve1Hu6Gi8Fo0Bj2Ek` | `fg7EIPpdDfZsNjjurCumYw` |
| `resident-credential` | `01a102b6-6253-74a0-92b1-9b0320a0f082` | `FFt87NO75HH6EvxevizavQ` |
| `child-card` | `2c74d8b9cfe5563fd20d0eab68e87c05e3cf6e86720d164659e7fba8ac5055f6` | `wNJTVMHiozNEvm6M5vEaCg` |

---

## The management app

Everything here needs `gate_devices.manage` (managers and security supervisors).

### Devices

- **`GET /staff/gate/devices?status=active|revoked|all`** and **`GET /staff/gate/devices/{id}`**: label, who enrolled it and when, `lastSeenAt`, `lastUploadAt`, `bundleVersion`, `bundleValidUntil`, `onShift`, `ackedSeq`, `maxSeq`, `missingActions`, `pendingCount`, `openFlags`, `notCarried {passes, workers}`, and the revocation.
- **`notCarried`** counts the passes and worker cards from before ADR 0043 and 0057 that the last bundle could not carry. They work online only until reissued.
- **`POST /staff/gate/devices/{id}/revoke {reasonCode}`**, with a code from `gateDeviceRevoke` (`lost`, `stolen`, `replaced`, `retired`, `compromised`, `other`).
  - A retry replays.
  - Revoking again is 409 `GATE_DEVICE_ALREADY_REVOKED`.

### Flags

- **`GET /staff/gate/offline/flags?status=open|cleared|reviewed|all&class=security|manager|info&deviceId=`** and **`GET …/flags/{id}`**: kind, class, status, batch, action, device, subject `{type, id}`, gate, shift, `params` (codes and numbers), `occurredAt`, and the review.
- **`POST /staff/gate/offline/flags/{id}/review {reviewCode}`**, with a code from `offlineFlagReview` (`confirmed`, `followed_up`, `false_alarm`, `other`).
  - Once only: 409 `GATE_OFFLINE_FLAG_REVIEWED`.
  - An `exit_without_entry` clears itself when its entry arrives.

### Batches

- **`GET /staff/gate/offline/batches?status=pending|reviewed|all&deviceId=`** and **`GET …/batches/{id}`**: the batch's device, uploader, receipt, offset, count, and each action's type, seq, status, reason and times. `pending` means it holds quarantined actions.
- **`POST /staff/gate/offline/batches/{id}/review {decision: "accept" | "reject"}`**.
  - Once only: 409 `GATE_OFFLINE_BATCH_REVIEWED`.
  - A batch with nothing quarantined is 409 `GATE_OFFLINE_BATCH_NOT_QUARANTINED`.

**The gate's settings** gain `offlineSyncAlertMinutes` (5–240, default 15): `GET`/`PATCH /staff/gate/settings` (`gate.manage`).

**The child alerts** (`GET /staff/security/child-alerts`) gain `outcome`: `refused`, or `left_unverified` for a child released offline whose escort did not verify at sync.

## Push notifications

| Kind | To | Params | Open |
|---|---|---|---|
| `gate_device.enrolled` | `gate_devices.manage` | — | the device |
| `gate_device.upload_rejected` (critical) | `gate_devices.manage`, once per device in 15 min | `reason`: `signature` \| `envelope` \| `payload` | the device |
| `gate_device.sync_overdue` | `gate_devices.manage`, once per outage | `minutes` | the device |
| `gate_device.sequence_gap` | `gate_devices.manage`, once per gap | `missing` | the device |
| `gate_offline.security_conflict` (critical) | `gate_devices.manage`, once per batch | `flags` (a count) | the batch's flags |
| `gate_offline.conflicts` | `gate_devices.manage`, once per batch | `flags` | the batch's flags |
| `gate_offline.lockdown_entered` (critical) | The guards on shift at the gate | — | the gate |

The household's child notices are ADR 0054's: `child.picked_up`, `child.exit_alone`, and `child.unauthorized_pickup` (critical, also to the keepers for `left_unverified`).

## Errors

| Code | Status | When |
|---|---|---|
| `GATE_DEVICE_NOT_FOUND` | 404 | No such device in the compound |
| `GATE_DEVICE_EXISTS` | 409 | The id is enrolled with another key |
| `GATE_DEVICE_LIMIT_REACHED` | 409 | 50 live devices (`params.max`) |
| `GATE_DEVICE_SIGNATURE_INVALID` | 422 | An enrolment proof or an envelope does not verify |
| `GATE_DEVICE_ENVELOPE_INVALID` | 422 | `params.reason`: `payload`, `purpose`, `tenant`, `device` or `sent_at` |
| `GATE_DEVICE_ENVELOPE_REPLAYED` | 409 | A bundle or heartbeat envelope sent again: make a new one |
| `GATE_DEVICE_REVOKED` | 403 | A bundle or heartbeat from a revoked device |
| `GATE_DEVICE_ALREADY_REVOKED` | 409 | Revoked already |
| `GATE_OFFLINE_FLAG_NOT_FOUND` | 404 | |
| `GATE_OFFLINE_FLAG_REVIEWED` | 409 | Reviewed already |
| `GATE_OFFLINE_BATCH_NOT_FOUND` | 404 | |
| `GATE_OFFLINE_BATCH_NOT_QUARANTINED` | 409 | Nothing to decide |
| `GATE_OFFLINE_BATCH_REVIEWED` | 409 | Decided already |
