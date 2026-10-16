# Patrols: backend notes for the guard app

What was built for a guard's patrols:
- the board at the post: the runs to start, the routes;
- starting a scheduled run, or one of your own;
- scanning checkpoints: QR, NFC or by hand, offline-ready;
- notes with photos at a checkpoint;
- sending where you walked;
- ending a run.

The management's side (checkpoints and their QR, routes, the runs' detail, the reports) is in the manager dashboard.
- The design decisions are in [ADR 0052](../../decisions/0052-patrols.md).
- The contract is `docs/api/openapi.v0.json` (regenerated) and the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`. Every route here needs `gate.operate` (the guard role), and most need an open shift (403 `NO_OPEN_SHIFT`).
- Lists are `{ "data": [...], "nextCursor": string | null }`; pass `nextCursor` back as `?cursor=`.
- Errors are `{ "statusCode", "code", "message", "params"?, "fields"?: [...] }`. Switch on `code` and `fields[].code`, never on `message`.
- **Every response is `Cache-Control: no-store`.** Do not cache them on the device, except the board's checkpoint list of your run under way (below).
- Instants are ISO 8601 UTC.
- Colleagues appear by first name (`{ id, firstName }`, or `{ id, erased: true }`).

## Contents

1. [The board](#the-board)
2. [Starting a run](#starting-a-run)
3. [Scanning](#scanning)
4. [Offline](#offline)
5. [Notes and photos](#notes-and-photos)
6. [Where you walked](#where-you-walked)
7. [Ending a run](#ending-a-run)
8. [My runs and a run's detail](#my-runs-and-a-runs-detail)
9. [Push notifications](#push-notifications)
10. [Value lists](#value-lists)
11. [Errors](#errors)
12. [Not built](#not-built)

---

## The board

### GET /gate/patrols → `PatrolBoardView`

On shift (403 `NO_OPEN_SHIFT`).

| Field | Meaning |
|---|---|
| `live` | Your run under way (`GuardRunDetailView`), or null. |
| `runs` | At your post: scheduled runs whose window is open or opens within 12 hours, and those started today. Each `GuardRunView`. |
| `routes` | Routes in service from your post: `{ id, nameEn, nameAr, ordered, expectedMinutes, checkpoints }`. A run of one may be started any time. |

A run (`GuardRunView`): `id`, `route { id, nameEn, nameAr }`, `post`, `kind` (`scheduled`, `adhoc`), `status`, `plannedAt`, `scheduledStart`, `windowEndsAt`, `startedAt`, `endedAt`, `endReason`, `late`, `checkpointsTotal`, `scannedCount`, `guard` (first name).

## Starting a run

### POST /gate/patrols/runs/{id}/start → 200 `GuardRunDetailView`

A scheduled run at your post.
- **From 15 minutes before `scheduledStart` until `windowEndsAt`**, else 409 `PATROL_RUN_NOT_STARTABLE` with `params.reason`: `too_early`, `window_closed`, `missed` or `cancelled`.
- **The first start wins:** someone else started it, 409 `PATROL_ALREADY_STARTED`.
- **One run under way per guard:** 409 `PATROL_RUN_ALREADY_LIVE`. End yours first.
- Another post's run: 404 `PATROL_RUN_NOT_FOUND`.
- Started more than 15 minutes after its start, it shows `late: true`.
- `Idempotency-Key` (a UUID): a retry answers the same run.

### POST /gate/patrols/routes/{id}/start → 201 `GuardRunDetailView`

A run of your own of a route from your post (`kind: adhoc`), on its current version. The same one-run rule; another post's route, or a retired one: 404 `PATROL_ROUTE_NOT_FOUND`. `Idempotency-Key`.

`GuardRunDetailView` adds what the run asks:

| Field | Meaning |
|---|---|
| `ordered` | Scan the checkpoints in `position` order. |
| `expectedMinutes` | How long it should take. |
| `timesOutAt` | Under way: when it is closed as timed out (twice the expected minutes). |
| `stops` | `[{ position, checkpointId, nameEn, nameAr, location, scan, note }]`. `location` is `{ lat, lng, radiusM }` or null; `scan` is `{ id, method, scannedAt, positionSuspect }` or null; `note` is `{ id, outcome }`, with `text` and `photos` on your own run. |

**Cache the run under way on the device**: you need its stops offline.

## Scanning

### POST /gate/patrols/runs/{id}/scans → 201 `ScanView`

Your run only (another's: 404 `PATROL_RUN_NOT_FOUND`).

```json
{
  "id": "0199c3d2-6f1a-7c3e-9a51-3b2f6e8d1c40",
  "method": "qr",
  "payload": "JWK1.<checkpointId>.<token>",
  "scannedAt": "2026-11-01T08:12:30.000Z",
  "lat": 30.0444, "lng": 31.2357, "accuracyM": 8
}
```

- **`id`**: make a UUIDv7 when the guard scans, and keep it with the scan until the server answers.
- **`method`**:
  - `qr`: the QR's text;
  - `nfc`: the NFC tag's text, the same `JWK1.…`;
  - `manual`: no payload, but `checkpointId` and a `reasonCode` (`qr_damaged`, `qr_missing`, `nfc_unreadable`, `other`). Missing: 400 `REASON_REQUIRED`. A hand scan shows as such everywhere.
- **`payload`**: anything that is not this compound's current QR of a checkpoint answers 422 `PATROL_CHECKPOINT_INVALID`: a malformed payload, another compound's, a retired checkpoint, an old printout after a reissue. Offer a hand scan.
- **`scannedAt`**: the device's time of the scan, inside the run's lifetime, two minutes either side; else 422 `PATROL_SCAN_OUT_OF_WINDOW`.
- **`lat`, `lng`, `accuracyM`**: the device's position, both coordinates or none; `accuracyM` only with them. Farther than the checkpoint's `radiusM`, the scan is kept and `positionSuspect: true`. Send what the device has; never block a scan on a fix.

Refusals:
- A checkpoint not on this route: 422 `PATROL_CHECKPOINT_NOT_ON_ROUTE`.
- Scanned already on this run: 409 `PATROL_CHECKPOINT_ALREADY_SCANNED`.
- **An ordered route** expects the next `position`, by device time: 422 `PATROL_OUT_OF_ORDER` with `params.expected`.

`ScanView`: `id`, `checkpointId`, `position`, `method`, `scannedAt`, `receivedAt`, `positionSuspect`, `run { status, scannedCount, checkpointsTotal }`. **The last checkpoint completes the run:** `run.status` is `completed`.

## Offline

The server is ready for an offline queue; the queue is the app's.

- **A scan or a note sent again with the same `id` records once and answers the same.** Another content under an id already used is 409 `IDEMPOTENCY_CONFLICT`: drop it, it is a bug.
- **Upload queued scans in `scannedAt` order**, one at a time per run. On an ordered route a scan sent before an earlier one answers 422 `PATROL_OUT_OF_ORDER`: keep it, send the earlier one, then send it again.
- **A scan reaching the server after the run ended** (the shift ended, it timed out, you ended it) is still recorded when its `scannedAt` falls in the run's lifetime. The run's status stays what it was; the management sees it was finished offline.
- Starting and ending a run need the server: they are decided there, first come first served.
- An old printout scanned offline before a reissue is refused when it arrives after it: scan that checkpoint by hand.

## Notes and photos

### POST /gate/patrols/runs/{id}/notes → 201 `NoteView`

```json
{
  "id": "0199c3d2-7a00-7c3e-9a51-3b2f6e8d1c41",
  "scanId": "<a scan of this run>",
  "outcome": "issue_found",
  "text": "The fence is cut by the pool",
  "notedAt": "2026-11-01T08:13:10.000Z",
  "photoFileIds": ["<file>"]
}
```

- One note per scan (409 `PATROL_NOTE_EXISTS`); `scanId` not of this run: 400 `VALIDATION_FAILED`, `scanId` `INVALID_VALUE`.
- While the run is under way, or up to 30 minutes after it ended (409 `PATROL_RUN_NOT_LIVE` after that).
- `outcome`: `all_clear` or `issue_found`. `text`: 1000 characters at most, optional.
- **Photos**, three at most, upload first:
  1. `POST /files/uploads { purpose: "patrol_photo", contentType, size }` (images, 5 MB);
  2. PUT the bytes to the URL answered;
  3. `POST /files/{id}/finalize`.

  A file not yours, not finalized, used already, or of another purpose: `photoFileIds` `FILE_NOT_AVAILABLE`.
- The same `id` rule as scans.

`NoteView`: `id`, `scanId`, `outcome`, `text`, `notedAt`, `receivedAt`, `photos` (how many).

The management reads your words and photos; another guard sees the outcome only.

## Where you walked

### POST /gate/patrols/runs/{id}/track → 200 `{ accepted, rejected }`

```json
{ "points": [{ "recordedAt": "…", "lat": 30.0444, "lng": 31.2357, "accuracyM": 6 }] }
```

- 1 to 100 points a batch, while the run is under way or up to 30 minutes after it ended; else 409 `PATROL_RUN_NOT_LIVE`.
- A point whose `recordedAt` is outside the run's lifetime (two minutes either side) is dropped and counted in `rejected`; the rest are kept. Do not send dropped points again.
- A point at an instant already recorded is ignored, so a batch sent again adds nothing: `accepted` counts the new ones only.
- Only a malformed batch is refused whole: no point, more than 100, a point without its time or coordinates (400 `VALIDATION_FAILED`). Drop it from the queue.
- Suggested pace: a point every 30 seconds while walking, a batch a minute.

### GET /gate/patrols/runs/{id}/track → `{ data: [TrackPointView], nextCursor: null }`

Your own runs only. Points are kept 30 days.

## Ending a run

### POST /gate/patrols/runs/{id}/end → 200 `GuardRunDetailView`

Your run under way (409 `PATROL_RUN_NOT_LIVE` otherwise).
- Every checkpoint scanned: `completed`. Normally the last scan has completed it already.
- Otherwise `incomplete` (`endReason: guard`): the roster's keepers are told.

**Ending your shift ends your run under way**, incomplete (`shift_ended`).

**A run under way twice its expected minutes is closed** as `timed_out` by the server.

## My runs and a run's detail

- `GET /gate/patrols/runs`: the runs you started, newest first (cursor).
- `GET /gate/patrols/runs/{id}`: one of yours, or one at the post where you are on shift (another's: 404 `PATROL_RUN_NOT_FOUND`).

## Push notifications

Category `guard_duty`; none is critical. Params are codes only.

| Kind | To | Params |
|---|---|---|
| `patrol.late` | the guards on shift at the run's post: a scheduled run nobody started 15 minutes after its start | none |
| `patrol.missed` | the roster's keepers | none |
| `patrol.incomplete` | the roster's keepers | `reason`: `guard`, `shift_ended`, `timed_out` |

`targetType` is `patrol_run`, `targetId` the run's id: open its detail.

## Value lists

| List | Values |
|---|---|
| `PatrolRunKind` | `scheduled`, `adhoc` |
| `PatrolRunStatus` | `scheduled`, `in_progress`, `completed`, `incomplete`, `timed_out`, `missed`, `cancelled` |
| `PatrolRunEndReason` | `guard`, `shift_ended` |
| `PatrolScanMethod` | `qr`, `nfc`, `manual` |
| `patrolManualScan` | `qr_damaged`, `qr_missing`, `nfc_unreadable`, `other` |
| `PatrolNoteOutcome` | `all_clear`, `issue_found` |

## Errors

| Code | Status | When |
|---|---|---|
| `NO_OPEN_SHIFT` | 403 | Not on shift. |
| `PATROL_RUN_NOT_FOUND` | 404 | Unknown, another compound's, another post's, or not yours. |
| `PATROL_ROUTE_NOT_FOUND` | 404 | Not a route in service from your post. |
| `PATROL_ALREADY_STARTED` | 409 | Someone started it first. |
| `PATROL_RUN_NOT_STARTABLE` | 409 | `params.reason`: `too_early`, `window_closed`, `missed`, `cancelled`. |
| `PATROL_RUN_ALREADY_LIVE` | 409 | Another run of yours is under way. |
| `PATROL_RUN_NOT_LIVE` | 409 | Not under way (end), or ended over 30 minutes ago (notes, track). `params.status`. |
| `PATROL_CHECKPOINT_INVALID` | 422 | Not this compound's current QR of a checkpoint. |
| `PATROL_CHECKPOINT_NOT_ON_ROUTE` | 422 | Not on this route. |
| `PATROL_OUT_OF_ORDER` | 422 | An ordered route expects `params.expected` first. |
| `PATROL_CHECKPOINT_ALREADY_SCANNED` | 409 | Scanned already on this run. |
| `PATROL_SCAN_OUT_OF_WINDOW` | 422 | A scan's or a note's device time is outside the run's lifetime (`params.field`). A track point outside it is dropped instead (`rejected`). |
| `PATROL_NOTE_EXISTS` | 409 | That scan has its note. |
| `IDEMPOTENCY_CONFLICT` | 409 | An id used for something else. |
| `REASON_REQUIRED` | 400 | A hand scan without its reason. |

## Not built

- No alert when a guard leaves a zone during a run (geofencing): the track shows it afterwards.
- No audio or video at a checkpoint.
- No dispatch from a control room; no incident raised from a note (G6b).
- No pause: a long interruption ends as timed out.
