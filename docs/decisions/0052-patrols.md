# 0052 — Patrols: checkpoints with a QR shown once, routes in versions on a weekly schedule, runs started first-wins and watched for lateness, absence and time-outs, offline-ready scans with where and how, notes with photos, the guard's track kept 30 days, and the patrols in the reports

**Status:** Accepted · Phase G5 · Gate card (patrols)

## Context

Since ADR 0050 a guard works a post, follows a roster, takes tasks and hands over. Nothing recorded a **patrol**. The compound could not:
- mark the points a round must pass, and know a guard was there;
- say which rounds walk which points, and when;
- see a round started late, missed or left unfinished;
- read what a guard found on the way, and where they walked.

The guard app and the manager dashboard need all of it. What already exists is reused:
- the posts (gates and zones, ADR 0050) and the shift's end hook;
- the roster's occurrences of a weekly schedule, DST included;
- the keepers (`guard_roster.manage` holders) and the guards on shift at a post (`SafetyCore`);
- the file flow (ADR 0029), the export sections and the erasure hooks (ADR 0036);
- the daily report and its CSV (ADR 0050);
- the gate entries' client ids (ADR 0028) for offline retries.

Out of scope:
- an alert when a guard leaves a zone (geofencing);
- audio and video;
- dispatch from a control room;
- incidents raised from a patrol (G6b);
- offline sync itself: the server is ready for it, the app's queue is the app's.

The model follows ADR 0044–0050:
- rules are decided under a lock, by the database's clock;
- rows move forward only, guarded by triggers;
- codes, not free text, outside what people write;
- every response is `no-store`;
- every table is under RLS, forced, with composite foreign keys.

## Decisions

### In the gate domain

One new folder, `src/gate/patrols`. `PatrolCore` holds the route's lock, its current version, a version's checkpoints in order and the views' names; `RunsCore` makes, cancels and ends runs.

**Lock order, everywhere:** the account (FOR SHARE) → the shift → the route → the run → the checkpoint.
- **A new version** takes the route FOR UPDATE, then its checkpoints FOR SHARE in id order, then the scheduled runs it replaces FOR UPDATE in id order.
- **A scan** takes the run FOR UPDATE, then a checkpoint FOR SHARE only.
- **A reissue or a retirement** takes the checkpoint alone.
- **The sweeps** take a run alone (SKIP LOCKED).

So there is no cycle.

### Checkpoints

Kept by `patrols.manage`:
- at a post (a gate, or a zone), with English and Arabic names (two in service never share one: 409 `DUPLICATE_RESOURCE`);
- with a position and a radius (30 m by default, 5 to 500), or none.

**Its QR and its NFC tag carry `JWK1.<checkpointId>.<token>`.**
- The token is 256 random bits (base64url, 43 characters).
- Only `hex(SHA-256("jiwar:patrol-checkpoint:v1:<tenant>:<checkpointId>:<token>"))` is kept, compared in constant time.
- **No key is involved.** The token is random and long enough for a plain hash, and rotating a pepper or a key must never make every printed QR stop scanning. The label keeps the hash apart from every other in the database.
- **The payload is answered once**, at creation and at a reissue. No read shows it again: to reprint, reissue. Neither takes an `Idempotency-Key`: a retried creation meets the unique name, and a retried reissue just reissues.
- **A reissue** takes the row FOR UPDATE and replaces the hash: the old printout stops scanning in that transaction. A scan verifies the token under its share lock, so it finished before or meets the new one.

A test vector, for the app's tests (Python's hashlib computed it):

| tenant | checkpoint | token | hash |
|---|---|---|---|
| `01a102b6-6253-74a0-92b1-96e7c9d52601` | `01a102b6-6253-74a0-92b1-9b0320a0f082` | `q3Jzx8b7m2Kd9PwS0aLr5TnYc4Ve1Hu6Gi8Fo0Bj2Ek` | `d418826836142d030db0cb261c6e8f48f9664b936803d734c676fe8be7e7775b` |

**Retired once, never deleted:** its scans point at it. Not while a route in service walks it (409 `PATROL_CHECKPOINT_IN_USE`, params.routes). This is decided under the checkpoint's row lock, which a new version takes FOR SHARE: the version committed first, or finds it retired (`CHECKPOINT_NOT_AVAILABLE`).

### Routes and their versions

A route is walked from a post and has names. What it asks is a **version**:
- its checkpoints in the order walked (1 to 50, each once, in service);
- whether that order is enforced;
- how long it takes (5 to 480 minutes);
- its weekly start times (`{days, times}`), or none.

**Changing any of it makes a new version.** A route's names change in place. One version is current (a unique index); a version never changes and is superseded once. A run keeps the version it was made with.

**A scheduled run's window** runs from its start for its expected minutes, 30 at least. So being late (15 minutes) always comes before being missed. Two start times closer than that window, on a day, over midnight or from Saturday into Sunday, are refused (`schedule.times`, `PATROL_SCHEDULE_OVERLAP`, params.minutes). The starts come from the roster's occurrences in the compound's time zone: a start the clock skips moves forward.

Retired once: its scheduled runs nobody started are cancelled (`route_retired`); a run under way finishes.

### Runs

**Made ahead.** A version's schedule makes its runs 7 days ahead:
- when the route is made, when it changes, and by an hourly sweep (`gate.patrol_schedule`, the route FOR SHARE);
- each once: a unique index on `(version, scheduled start)` keeps cancelled ones too, so nothing cancelled comes back.

A new version cancels the scheduled runs nobody started (`route_changed`) and makes its own, in its transaction.

**Started.** A guard on shift at the post starts a scheduled run there:
- from 15 minutes before its start until its window ends;
- otherwise 409 `PATROL_RUN_NOT_STARTABLE` (params.reason: `too_early`, `window_closed`, `missed`, `cancelled`);
- **the first start wins** (409 `PATROL_ALREADY_STARTED`);
- a start more than 15 minutes late marks it late, once, if the watch did not yet.

A guard may also start **a run of their own** (`adhoc`) of a route in service from their post, on its current version.

**One run under way per guard** (409 `PATROL_RUN_ALREADY_LIVE`): checked, and a partial unique index maps the race to the same code.

A start takes the guard's account FOR SHARE (a deactivation holds it first), their open shift FOR SHARE (its end waits, or the start finds it ended), the route FOR SHARE (a new version waits, or the start finds its run cancelled), then the run FOR UPDATE.

**States**, forward only (a trigger):
- `scheduled → in_progress | missed | cancelled`;
- `in_progress → completed | incomplete | timed_out`.

**`planned_at`** is when a run was meant: its scheduled start, or an unscheduled run's start. The reports count runs by it.

**Ended:**
- **The last checkpoint scanned completes a run under way.**
- **The guard ends it** (`POST …/end`): completed with every checkpoint scanned, else incomplete (`guard`).
- **The guard's shift ends** (an end hook, for every end): incomplete (`shift_ended`), in the end's transaction, under the run's row lock.
- **A run ending short tells the roster's keepers**, in that transaction (`patrol.incomplete`).

**The watch** (`gate.patrol_watch`, every minute) takes each due run FOR UPDATE SKIP LOCKED and judges it again under the lock, by the database's clock. So a start holding it wins.

| Mark | When | Told |
|---|---|---|
| late, once | a scheduled run not started 15 minutes after its start | the guards on shift at its post (`patrol.late`) |
| missed | not started when its window ends | the roster's keepers (`patrol.missed`) |
| cancelled (`post_out_of_service`) | the same, at a post out of service | nobody; it is nobody's miss |
| timed out | under way twice its expected minutes | the roster's keepers (`patrol.incomplete`, `timed_out`) |

A post out of service is nobody's lateness either.

The management (`patrols.manage`) cancels a scheduled run nobody started, with a `patrolRunCancel` code (409 `PATROL_RUN_CLOSED` otherwise).

### Scans

A guard records on their run:
- the checkpoint's QR or NFC payload;
- or **by hand**, with a `patrolManualScan` code. It is marked `manual` everywhere it shows.

**Offline-ready:**
- Each scan carries the app's own UUIDv7 and the device's time.
- **The same id again answers the same**; other content under it is 409 `IDEMPOTENCY_CONFLICT`.
- **The device's time must fall in the run's lifetime**: from its start to its end (or now while under way), two minutes either side (422 `PATROL_SCAN_OUT_OF_WINDOW`). The server keeps when it received it too.
- **A scan reaching the server after its run ended**, with a device time inside its lifetime, is recorded. The run's status stays: rows move forward only. The management sees it as a late scan (`lateScans`): the run was finished offline.

**Serialized by the run's row**, taken FOR UPDATE first: a duplicate id waits and finds the first, and the shift's end waits or is seen.

**Answers:**
- Anything that is not this compound's current QR gets one answer, 422 `PATROL_CHECKPOINT_INVALID`: a malformed payload, an unknown or retired checkpoint, another compound's, an old printout.
- A checkpoint off the run's route: 422 `PATROL_CHECKPOINT_NOT_ON_ROUTE`.
- Each checkpoint once per run (409 `PATROL_CHECKPOINT_ALREADY_SCANNED`).
- **An ordered route** takes its checkpoints in order, by device time (422 `PATROL_OUT_OF_ORDER`, params.expected). The app uploads its queued scans in `scannedAt` order, and sends a refused one again after the earlier one lands.

**Where:** a scan carries the device's latitude, longitude and accuracy, or none.
- Farther from the checkpoint than its radius (a great-circle distance), it is **kept and flagged** `positionSuspect`.
- The management sees where and how far; guards see the flag only.

Scans are their own immutable log, like the gate's entries, and are not audited.

### Notes

A note at a scan of the guard's run:
- an outcome (`all_clear`, `issue_found`);
- words (1000 at most);
- up to three photos, of the new purpose `patrol_photo` (images, 5 MB), claimed and attached as a task's.

One per scan (409 `PATROL_NOTE_EXISTS`), with the same id rule, while the run is under way or up to 30 minutes after it ended. Its words and photos reach its author and the management; another guard sees its outcome.

### Where a guard walked

The app sends its positions in batches of up to 100:
- during a run, or up to 30 minutes after it ended (its offline queue); otherwise 409 `PATROL_RUN_NOT_LIVE`;
- **a point outside the run's lifetime (two minutes either side) is dropped**, and the rest are kept: one stray clock never costs a batch;
- a point at an instant already recorded for the run is ignored, so a batch sent again adds nothing;
- the answer says how many of each: `{ accepted, rejected }`.

Only a malformed batch is refused whole (no point, more than 100, a bad point): 400 `VALIDATION_FAILED`, as any invalid body.

**The guard's location is personal data:**
- read by `patrols.manage` and by the guard on their own runs, never by `guard_reports.read` or another guard, and never inside a run's detail;
- deleted 30 days after it was recorded by an hourly sweep (`gate.patrol_track_purge`; how many audited, per compound), and at the guard's erasure.

A point never changes. The app may delete one, never truncate the table.

### Reports

**The patrol report** (`GET /staff/security/patrols/report`, `patrols.manage` or `guard_reports.read`) covers each route over the compound's days asked (a week by default, 31 at most), counting the runs planned then:
- scheduled (cancelled ones left out), unscheduled, done, late, missed, incomplete (timed out included), cancelled;
- the scans by hand, flagged and received late;
- the average length of a completed run.

It uses two fixed aggregate queries.

**The daily report (ADR 0050) gains each post's patrols** planned that day: `patrols: { scheduled, done, late, missed, incomplete }`, at gates and in zones alike. A zone is listed when one happened there. The CSV carries them as its last five columns: `patrols_scheduled`, `patrols_done`, `patrols_late`, `patrols_missed`, `patrols_incomplete`.

### Permissions

| Permission | Who holds it |
|---|---|
| `patrols.manage` | staff or manager; the manager role and the security supervisor. Checkpoints, routes, cancelling runs, reading tracks |
| `gate.operate` | the guards: they start, scan, note and send their track inside a shift |
| `guard_reports.read` | also reads runs and the patrol report |

`pnpm access:sync` brings `patrols.manage` to existing compounds.

### Notifications

Category `guard_duty`; none critical. Params are codes at most: never a name, a route or a post.

| Kind | To |
|---|---|
| `patrol.late` | the guards on shift at the run's post |
| `patrol.missed` | the roster's keepers |
| `patrol.incomplete` (`reason`: `guard`, `shift_ended`, `timed_out`) | the roster's keepers |

### Privacy and audit

**Audit:** ids, codes and counts.
- A checkpoint's and a route's names, and a checkpoint's position, go in as changed.
- A token or its hash never goes in, nor a note's words, a scan's position or a track.

**Erased** (a guard's account, deactivated first), in that transaction:
- their notes' words go, once each, audited by id;
- their track points are deleted, how many audited.

The notes' outcomes and photos stay (a photo shows a place), and so do their runs and scans: the compound's record of its patrols. The guard shows as `{ id, erased: true }`.

**Export** (`patrols/`):
- the runs they started (route and post by name);
- their scans with their device's position;
- their notes (outcome, words, how many photos);
- their track while it is kept.

Never another guard's name or words.

**Who sees whom:** guards see each other by first name, the management by full name.

## Consequences

- **Migrations** (`20261030090000` to `20261030090600`):
  - checkpoints;
  - routes, versions and their checkpoints;
  - runs;
  - the `patrol_photo` enum value alone;
  - both file CHECKs recreated with every purpose (G3's and G4's, recreated before in `20261028090600`, included), with a schema test that inserts a file of every purpose the database knows;
  - scans, notes and their photos;
  - track points.
- **Nine new tenant tables**, each under RLS, forced, with composite keys. Every CHECK is reviewed in the CHECK map. Triggers keep what never changes; nothing is deleted by the app but track points.
- **This amends ADR 0050:** the daily report and its CSV gain each post's patrols.
- **This amends ADR 0036 and 0029:**
  - a `patrols` export section;
  - the file purpose `patrol_photo`;
  - the erasure clears notes' words and deletes track points.
- **The manager dashboard's Security group** gains Checkpoints (with the QR to print, drawn in the browser), Patrol routes, Patrol runs and the Patrol report; the daily report page shows the patrols.
- **The guard app's notes** are in [`docs/api/notes/patrols.md`](../api/notes/patrols.md).

## Open

- **No geofence alert:** a guard leaving a zone mid-run tells nobody; the track shows it afterwards.
- **A late scan never completes an ended run.** The management reads `lateScans`.
- **An old printout scanned offline before a reissue** is refused when it arrives after it: the guard scans that checkpoint by hand.
- **A run under way has no pause:** a long interruption ends as timed out.
