# Guard completion: backend notes for the guard app and the management app

What was built to complete the guard's work at the gate and on patrol:

- a guard asks the on-duty management to let in, once, someone the gate refused (a field exception);
- a visitor still inside past their visit's length alerts the gate and the host;
- service vehicles are recorded in and out, and resident vehicles are counted;
- the guard may photograph a visitor at the entry;
- there is a directory of the posts, a traffic report and a gate log search;
- instructions can hold for a set of days;
- a patrol route can have a geofence;
- patrol notes and incidents take sound and video;
- the incident report can be signed.

The design decisions are in [ADR 0056](../../decisions/0056-guard-completion.md). The contract is `docs/api/openapi.v0.json` (regenerated) and the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`.
- Lists are `{ "data": [...], "nextCursor": string | null }`. Pass `nextCursor` back as `?cursor=`.
- Errors are `{ "statusCode", "code", "message", "params"?, "fields"?: [...] }`. Switch on `code` and `fields[].code`, never on `message`.
- **Every response here is `Cache-Control: no-store`.** Never cache a photo, a recording, a name or a plate on the device.
- Days are `YYYY-MM-DD` in the compound's time zone. Instants are ISO 8601 UTC.
- A `POST` marked idempotent takes an `Idempotency-Key` header (a UUID). Retry with the same key and the same body.

## Contents

1. [The guard app](#the-guard-app)
2. [The management app](#the-management-app)
3. [Recordings: record in MP4](#recordings-record-in-mp4)
4. [Push notifications](#push-notifications)
5. [Errors](#errors)

---

## The guard app

Everything here needs `gate.operate`. Everything except the directory also needs an open shift at a post (403 `NO_OPEN_SHIFT`).

### Field exceptions

When the gate refuses someone, the guard may ask the management to let them in, once.

**1. Ask.** `POST /gate/field-exceptions` (idempotent), with `kind` and a `reasonCode` from `gateExceptionRaise`. Each kind takes what it needs and nothing else (FIELD_REQUIRED / FIELD_NOT_ALLOWED):

| `kind` | Needs |
|---|---|
| `worker_outside_hours` | `worker: {type: worker_engagement \| permit_worker, id}`, no unit |
| `visitor_without_pass` | `unitCode`, `visitorName` |
| `unregistered_vehicle` | `unitCode`, `vehiclePlate` |

- `idNumber` is optional: the full number on the card they show. It is matched against the blocklist and never stored.
- It is refused during a lockdown (`LOCKDOWN_ACTIVE`) and for a banned person or plate (`ENTRY_BLOCKED`).
- A worker the gate would let in anyway is `GATE_EXCEPTION_NOT_NEEDED`.

**2. Wait.** The answer comes as a critical push, `gate_exception.decided` or `gate_exception.expired`. While waiting, poll `GET /gate/field-exceptions/{id}`.

- `answerBy` is when it expires (10 minutes by default).
- `status` is one of `pending`, `approved`, `rejected`, `expired` or `withdrawn`.
- A rejection carries `rejectReasonCode`.

**3. Let them in.** Once `approved`, record the entry before `entryUntil`, at the same gate: `POST /gate/entries` with `subjectType: field_exception`, `subjectId: <the exception>` and `direction: in`.

- It is used once. A second entry is refused.
- For a worker, the entry is recorded as the worker (`worker` in the view says who): the exception only waives their hours.
- A lockdown or a ban that started meanwhile still refuses it.

**4. Changed your mind?** `POST /gate/field-exceptions/{id}/withdraw`, while it is pending.

### The visitor's photo

For a visitor's `in` (a pass, a gate request, a field exception), upload a `visitor_photo` (image, 5 MB) first, then send its id as `photoFileId` with `POST /gate/entries`.

- It is shown in `GET /gate/inside` and `GET /gate/entries/{id}/photo` to the guards on shift and the management. Never to the household.
- It is deleted 30 days after the entry, unless an incident keeps it (below).

### Service vehicles

- `POST /gate/service-vehicles` (idempotent) records one coming in: `plate`, `kind` (`tanker`, `waste`, `delivery` or `other`), `company` (up to 120), and optionally `unitCode` or `facilityId`.
  - It is refused during a lockdown (`LOCKDOWN_ACTIVE`) and for a banned plate (`ENTRY_BLOCKED`).
  - A watched plate comes in, flagged.
  - A plate is inside once at a time (409 `SERVICE_VEHICLE_INSIDE`, with `params.id` the visit to close first).
- `POST /gate/service-vehicles/{id}/exit` records it leaving (409 `SERVICE_VEHICLE_NOT_INSIDE` when it already left).
- `GET /gate/service-vehicles` lists the ones inside now.
- The plate lookup gains `serviceVehicles`: the visits inside with that plate.

### Resident vehicles: count, never log

After the plate lookup finds a registered resident vehicle, tap in or out: `POST /gate/vehicle-passages` (idempotent) with `{vehicleId, direction}`.

- It answers `{ "counted": true }` and nothing else.
- Only a count per day, gate and direction is kept: no vehicle, no time.

### The directory

`GET /gate/directory` lists the compound's active gates with their own phones, and for each gate and zone the guards on shift, by first name. Never a personal phone.

### Instructions with validity

An instruction may hold from one day to another (`validFrom` / `validUntil`).

- You see and acknowledge only those that hold today. On another day the same instruction is 404.
- You are pushed once: at the send if it holds that day, otherwise when you open a shift on a day it holds.
- The pending count on `/gate/my-work` counts today's only.

### Patrols: the geofence

Nothing changes in what the app sends. Keep sending the track while the run is under way, and the offline queue in order, within 30 minutes of the end. A route with a geofence shows it as `version.geofence`:

- `{circle: {lat, lng, radiusM}}`, or
- `{polygon: [[lat, lng], …]}`.

The server works out when the guard was outside and flags it to the management. Send each point's `accuracyM`:

- a point counts as outside only when it is further out than its accuracy;
- a point less precise than 100 m is ignored for the geofence.

### Recordings

A patrol note (`POST /gate/patrols/runs/{id}/notes`) takes up to two `mediaFileIds`; an incident's report (`POST /gate/incidents`) up to three. See [Recordings](#recordings-record-in-mp4) for the uploads.

### Evidence

Your own incident (`POST /gate/incidents/{id}/evidence`, while it is not closed) may keep either of these past their 30 days:

- a visitor's photo: `{kind: visitor_photo, entryId}`;
- your own patrol run's track: `{kind: patrol_track, runId}`.

Each is kept once (`INCIDENT_EVIDENCE_EXISTS`), ten at most (`INCIDENT_EVIDENCE_LIMIT`).

### Signing the incident report

1. Upload the drawn signature as an `incident_signature` (PNG, 256 KB).
2. Send `POST /gate/incidents/{id}/signatures` with `{role: author, fileId}`.

What happens next:

- You sign your own reports as their `author`.
- The signature covers the report as it is now. If the report changes later (for example, evidence is linked), `GET /gate/incidents/{id}/signatures` shows it as `superseded: true`; sign again.
- A close never supersedes the author's signature.
- Signing the same content twice is 409 `INCIDENT_ALREADY_SIGNED`.

---

## The management app

### Field exceptions (`gate_exceptions.decide`, managers)

- **`GET /staff/gate/field-exceptions?status=pending|decided|all`**, newest first. `pending` is what may still be answered now.
- **`GET /staff/gate/field-exceptions/{id}`** shows the visitor's name or the plate (while the visitor's data lasts, 30 days), the worker's name, the gate, the guard who asked, and the decider.
- **`POST /staff/gate/field-exceptions/{id}/decide`** (idempotent): `{decision: approve}` or `{decision: reject, reasonCode}`, the code from `gateExceptionReject`.
  - Every holder is asked, and the first answer wins: any other is 409 `GATE_EXCEPTION_DECIDED`, with `params.status`.
  - Past `answerBy` it is `expired`.
  - Show a countdown to `answerBy`, and refresh what waits every few seconds.

### The gate's settings (`gate.manage`)

`GET` / `PATCH /staff/gate/settings`. A `PATCH` sends only what changes; null is allowed for `visitExpectedMinutes` only (it turns the overstay alert off).

| Setting | Default | Range |
|---|---|---|
| `exceptionAnswerMinutes` | 10 | 1–60 |
| `exceptionEntryMinutes` | 15 | 5–120 |
| `visitExpectedMinutes` | 240 | 15–720, or null |
| `geofenceExitMinutes` | 3 | 1–60 |
| `audioMaxSeconds` | 300 | 10–600 |
| `videoMaxSeconds` | 120 | 10–300 |
| `audioMaxMb` | 20 | 1–20 |
| `videoMaxMb` | 100 | 1–100 |

### Visits

A pass may say how long its visit takes: `expectedMinutes`, 15–720. Without it, the compound's `visitExpectedMinutes` applies.

### The traffic report (`gate.read`)

`GET /staff/gate/reports/traffic?from&to&gateId`, and `/export` for a CSV with the totals last. It gives, per day and gate:

- visitors, by pass, gate request or field exception;
- service vehicles, by kind;
- resident vehicles in and out.

Counts only. 31 days at most; the last seven by default. `GET /staff/gate/service-vehicles` lists the service vehicles' visits.

### The gate log search (`gate_log.search`, managers)

`POST /staff/gate/log-search` with `{from, to, unitId?, visitorName?}` (31 days at most).

- It answers the entries, without names, newest first: 200 at most, with `truncated` when there were more.
- **A name matches exactly:** case, spaces and Arabic letter forms are folded, and a part of a name finds nothing.
- **Name search covers the last 30 days only.** A visitor's name is deleted 30 days after their pass or request, and so is what the search matches on.
- It is a POST so the name never sits in a URL. Nothing of the name is kept or logged; each search is audited without it.
- 20 searches per 10 minutes (429 `RATE_LIMITED`).

### Instructions

`GET /staff/security/instructions?state=scheduled|live|expired|archived`. Each instruction shows its `state`, `validFrom` and `validUntil`.

To send one for a set of days, pass `validFrom` / `validUntil`:

- `validUntil` before `validFrom` is ENDS_BEFORE_START;
- a `validUntil` already past is DAY_OUT_OF_RANGE.

### Patrols

- A route's version may carry `geofence`, a circle (10–5000 m) or a polygon (3–50 vertices whose edges never cross: INVALID_VALUE). Changing it makes a new version, as any change does.
- An exit lasting `geofenceExitMinutes` sends `patrol.geofence_exit` (the run, the minutes) to `patrols.manage`, once per exit.
- `GET /staff/security/patrols/runs/{id}/geofence-exits` lists the exits: `leftAt`, `backAt`, `flaggedAt`. Times only.
- A run's detail shows each note's `media`.

### Incidents

- **An incident shows its `media`** (sound and video, with their lengths) next to its photos.
- **Evidence:** `POST /staff/security/incidents/{id}/evidence` keeps a visitor's photo or a patrol run's track. The track itself is read where it always is, `GET /staff/security/patrols/runs/{id}/track`, with `patrols.manage`.
- **Signatures:** `POST /staff/security/incidents/{id}/signatures` takes `{role, fileId}`.
  - A keeper who did not report the incident signs as `reviewer`; the author signs as `author`. Anyone else is 403 `INCIDENT_SIGNER_NOT_ELIGIBLE`.
  - The reviewer's signature covers the status, the outcome and the closing note too. So **closing the incident supersedes a reviewer's signature taken before the close**: sign again after closing. A close never supersedes the author's.
  - `GET …/signatures` shows each signature's `superseded`, its `contentSha256`, and the image while its signer's account exists.

---

## Recordings: record in MP4

**Record in an MP4 container, nothing else.**

| Recording | Content type |
|---|---|
| Sound | `audio/mp4` (an `.m4a`: AAC in MP4) |
| Video | `video/mp4`, or `video/quicktime` (an iPhone `.mov`) |

The server reads the length from the container. WebM, MP3, OGG, WAV and 3GP are refused at upload (`FILE_TYPE_NOT_ALLOWED`). On Android, record with `MediaRecorder` set to `OutputFormat.MPEG_4` with AAC (and H.264 for video); on iOS, `AVAudioRecorder` with `kAudioFormatMPEG4AAC`, or the camera's MOV/MP4.

| Purpose | Who uploads | Cap |
|---|---|---|
| `patrol_note_audio`, `patrol_note_video` | the guard (`gate.operate`) | 20 MB sound, 100 MB video |
| `incident_audio`, `incident_video` | the guard, or `incidents.manage` | 20 MB sound, 100 MB video |

The compound may set lower caps, and limits the seconds (5 minutes of sound and 2 of video by default). These are checked when the recording is attached (`FILE_TOO_LARGE` with `params.maxBytes`; `MEDIA_TOO_LONG` with `params.maxSeconds`). So read `GET /files/{id}` → `durationMs` after finalize, and warn before sending.

**Finalize** (`POST /files/{id}/finalize`) reads the length from the file's `moov` box, whether the recorder wrote it at the start or the end. It refuses:

- a container it cannot read (a cut-off upload or a damaged file): 422 `FILE_MEDIA_UNREADABLE`, with `params.reason`;
- a container that holds no movie header: 422 `FILE_MEDIA_NO_DURATION`.

Either way the upload is deleted: record again, in MP4. No transcoding happens; what you upload is what is played.

---

## Push notifications

Codes only: never a name, a plate or a position.

| Kind | To | Params | Critical |
|---|---|---|---|
| `gate_exception.requested` | every `gate_exceptions.decide` holder | `exceptionKind`, `unitCode`, `gateName` | yes |
| `gate_exception.decided` | the guard who asked | `decision`, `unitCode` | yes |
| `gate_exception.expired` | the guard who asked | `unitCode` | yes |
| `visit.overstayed` | the guards on shift at the visitor's gate (else every guard on shift) | `unitCode`, `minutes` | no |
| `visit.overstayed_host` | the host | `unitCode`, `minutes` | no |
| `patrol.geofence_exit` | `patrols.manage` | `minutes` (target: the run) | no |

`guard_instruction.issued` / `.urgent` now come at the first shift start on a day the instruction holds, when it did not hold at the send.

## Errors

| Code | When |
|---|---|
| `GATE_EXCEPTION_NOT_FOUND` (404) | not an exception of yours (a guard: of your gate) |
| `GATE_EXCEPTION_DECIDED` (409) | answered, expired or withdrawn already; `params.status` |
| `GATE_EXCEPTION_NOT_NEEDED` (409) | the worker may come in as they are |
| `SERVICE_VEHICLE_NOT_FOUND` (404) | not a visit of this compound |
| `SERVICE_VEHICLE_INSIDE` (409) | the plate is inside; `params.id` the visit |
| `SERVICE_VEHICLE_NOT_INSIDE` (409) | its exit was recorded already |
| `ENTRY_PHOTO_NOT_FOUND` (404) | no photo of this entry, or deleted (30 days) |
| `INCIDENT_EVIDENCE_EXISTS` (409) / `INCIDENT_EVIDENCE_LIMIT` (409) | kept already / ten kept, `params.max` |
| `FILE_MEDIA_UNREADABLE` (422) | a recording's container cannot be read; `params.reason` |
| `FILE_MEDIA_NO_DURATION` (422) | a recording with no movie header |
| `MEDIA_TOO_LONG` (field) | longer than the gate allows; `params.maxSeconds` |
| `INCIDENT_SIGNER_NOT_ELIGIBLE` (403) | not this role's signer; `params.role` |
| `INCIDENT_ALREADY_SIGNED` (409) | this content is signed in this role already |
| `RATE_LIMITED` (429) | the log search, 20 per 10 minutes |
