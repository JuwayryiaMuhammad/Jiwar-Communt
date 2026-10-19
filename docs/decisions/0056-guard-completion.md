# 0056 — Guard completion: field exceptions, visit overstay, service vehicles, the visitor's photo, the gate directory, the traffic report, the log search, instructions with validity, the patrol geofence, recordings and signed incident reports

**Status:** Accepted · Phase G7 · Gate card (completion)

## Context

The gate card (ADR 0043, 0045, 0049–0054) records who comes in and goes out. It also runs the guards' shifts, patrols and incidents. The field still had gaps:

- a guard had no way to ask the management to let in someone the gate refused;
- nothing noticed a visitor who stayed too long;
- nothing recorded the trucks that serve the compound;
- the guard took no photo at the entry;
- the guards had no directory of the posts;
- the management had no traffic report, and no way to find a visitor in the log;
- instructions held from when they were sent until archived;
- a patrol could leave its area unnoticed;
- patrol notes and incidents took photos only;
- nobody signed an incident report.

This ADR adds those eleven pieces. It also adds the manager dashboard's pages for the field exceptions and the gate's settings.

Out of scope, for later phases:

- offline (O1);
- face recognition, ID OCR, masked calling, man-down and the control room (G8);
- any AI.

The model is the gate card's:

- rules are decided under a lock, by the database's clock (`dbNow`);
- rows move forward only, guarded by triggers;
- codes are used instead of free text outside what people write;
- every response is `no-store`;
- every new table is under RLS, forced, with composite foreign keys;
- the audit holds ids, codes and counts only.

**Lock order, for every guard write:**

1. the account (FOR SHARE);
2. the shift (FOR SHARE);
3. the lockdown state (FOR SHARE);
4. the blocklist (advisory, shared);
5. the subject's rows;
6. the counters.

A manager's decision takes their account, then the subject. Sweeps take the subject with SKIP LOCKED.

**This amends:**

- ADR 0029: four recording purposes, a signature purpose, the duration read at finalize, ranged reads;
- ADR 0031: resident vehicles are counted, never logged;
- ADR 0036: export sections and notification kinds;
- ADR 0043: an entry on a field exception, the visitor's photo, `/gate/inside` no-store;
- ADR 0045: the plate lookup gains service vehicles;
- ADR 0050: instructions with validity, the daily report's service vehicles;
- ADR 0052: the patrol geofence, the track kept with an incident, a note's recordings;
- ADR 0053: incidents keep evidence, take recordings, and are signed.

## Decisions

### The gate's settings

**`gate_settings`:** one row per compound, created with it (`TenantLifecycle`) and backfilled by its migration.

- **Who:** `GET` / `PATCH /staff/gate/settings`, `gate.manage`. A change is audited as `gate_settings.changed`, with the values from and to.
- **Locking:** a write that depends on a value reads the row FOR SHARE, so a change waits for it or applies to it whole. What was decided under the old values keeps them; an exception's deadline is written on it.
- **Columns:** each feature added its own column in its own migration. The bounds live in `GATE_SETTING_LIMITS` and in the table's CHECKs.

| Value | Default | Bounds |
|---|---|---|
| `exceptionAnswerMinutes` | 10 | 1–60 |
| `exceptionEntryMinutes` | 15 | 5–120 |
| `visitExpectedMinutes` | 240 | 15–720, or null (no overstay alert) |
| `geofenceExitMinutes` | 3 | 1–60 |
| `audioMaxSeconds` | 300 | 10–600 |
| `videoMaxSeconds` | 120 | 10–300 |
| `audioMaxMb` | 20 | 1–20 |
| `videoMaxMb` | 100 | 1–100 |

### 1. Field exceptions

**The request.** A guard on shift at a gate asks the on-duty management to let in, once, someone the gate refused:

- `POST /gate/field-exceptions`, idempotent;
- a kind: `worker_outside_hours` (it names the worker: a household's engagement or a permit's worker), `visitor_without_pass` (the unit and the visitor's name) or `unregistered_vehicle` (the unit and the plate);
- a reason code from `gateExceptionRaise`.

Each kind takes what it needs and nothing else (FIELD_REQUIRED / FIELD_NOT_ALLOWED). An ID number may be shown: it is matched against the blocklist and never stored, not even in the idempotency record.

**The record.** `gate_field_exceptions` holds:

- a number (`GX-000042`);
- the gate, the shift and the guard;
- the unit;
- `answer_by`, which is the raise plus `exceptionAnswerMinutes`.

A visitor's name lives in `visitor_details` and goes after 30 days, as every visitor's does. The plate has the standard `plate_key`.

**Who answers.**

- The new permission `gate_exceptions.decide` (managers only) is held by the on-duty management. There is no duty roster, so every holder is asked with the critical `gate_exception.requested` (the kind, the unit's code and the gate's name; never a name or a plate).
- **The first answer wins:** `POST /staff/gate/field-exceptions/{id}/decide` takes `approve`, or `reject` with a `gateExceptionReject` code. It is decided under the row's lock by the database's clock; any later answer is 409 `GATE_EXCEPTION_DECIDED` with `params.status`.
- The guard is told with the critical `gate_exception.decided`.
- The guard may withdraw it while it is pending.

**Expiry.** Unanswered by `answer_by`, it expires:

- lazily, on every read under the lock and every answer (the answer is refused, `expired`);
- and by the sweep `gate.field_exceptions`.

The guard is told once, with the critical `gate_exception.expired`. The deadline is checked before the idempotency claim, so a refused late answer stores nothing.

**The entry.**

- An approval lets one entry in, at the exception's gate, until `entry_until`, which is the decision plus `exceptionEntryMinutes`.
- The guard records it with `POST /gate/entries` (`subjectType: field_exception`). The entry is recorded under the exception's lock and marks it used once (`used_at`, the entry's id).
- `gate_entries` gains `field_exception_id` and the method `exception`; a CHECK ties the two together.
- **A worker's exception waives their hours only.** The entry is recorded as the worker, and anything else that refuses the worker still refuses them.
- **It never overrides a lockdown or a ban.** Both are checked at the raise and again at the entry. A ban found at the raise is recorded as a blocklist match (source `field_exception`).

**The lock order** follows the guard writes, then the exception (FOR UPDATE), the worker, the settings row (FOR SHARE) and the counter.

`EntriesService.record` now takes the guard's account, then their shift, both FOR SHARE, as every other guard write does: a shift's end waits for an entry in flight, or ended first and the entry is refused.

**Audit:**

- `gate_exception.raised`: the number, the kind, the reason, the unit, the gate, the shift and the worker. The visitor's name and the plate appear as booleans only.
- `gate_exception.decided`, `gate_exception.expired` (by the system) and `gate_exception.withdrawn`.

### 2. Visit overstay

**The expected length.** A visit's expected length is its pass's `expected_minutes` (optional, 15–720). Otherwise it is the compound's `visitExpectedMinutes`; null turns the alert off.

**The sweep.**

- `gate.visit_overstay` finds the visitors still inside: passes, gate requests and field exceptions.
- "Inside" follows the gate log's own rule: exits close entries first in, first out.
- Past their length, it alerts once per visit. `visit_overstay_alerts` is keyed by the `in` entry, written with `ON CONFLICT DO NOTHING`, so two sweeps at once alert once.

**Who is told:**

- `visit.overstayed`: the guards on shift at the gate the visitor came in by, or every guard on shift when none is there;
- `visit.overstayed_host`: the host — the pass's host, or the household member who let a gate request in, otherwise the unit's inviters. A field exception's visitor has no host.

Both carry the unit's code and the minutes. Nothing else happens: no exit is recorded and nobody is refused.

### 3. Service vehicles

**The record.** Tankers, waste trucks, deliveries and others are recorded in and out by a guard on shift:

- `POST /gate/service-vehicles`, idempotent;
- `POST /gate/service-vehicles/{id}/exit`;
- `GET /gate/service-vehicles` for the ones inside;
- `GET /staff/gate/service-vehicles` for `gate.read`.

**Checks at the entry.** The plate is matched as every plate is:

- a lockdown refuses it (`LOCKDOWN_ACTIVE`);
- a ban refuses it (`ENTRY_BLOCKED`), recorded with the keepers told;
- a watch lets it in, flagged.

Exits are always recorded.

**Deviation: its own table.** `service_vehicle_visits` holds the plate (with `plate_key`), the kind, the company, an optional unit or facility, the entry's and exit's gates and times, and `exit_unconfirmed`. These are not `gate_entries` rows: `gate_entries.unit_id` is NOT NULL, and a tanker may serve no unit.

**One inside at a time.** A plate is inside once at a time. The entry takes an advisory lock on the plate's key, and a partial unique index backs it (409 `SERVICE_VEHICLE_INSIDE`, `params.id`). The sweep `gate.service_vehicle_exits` gives a visit inside longer than `GATE_UNCONFIRMED_EXIT_HOURS` the system's unconfirmed exit.

**What else changes:**

- The plate lookup (ADR 0045) gains `serviceVehicles`, the visits inside with that plate. Its other results keep their unit, so this is a separate array.
- The daily report (ADR 0050) gains `serviceVehicles` per post, and its CSV gains a last column, `service_vehicles`.
- Audit: `service_vehicle.entered`, `service_vehicle.exited` and `service_vehicle.exit_unconfirmed`, with the kind, the unit or facility, the gate and the shift. Never the plate or the company.

### 4. The visitor's photo at entry, and an incident's evidence

**Taking the photo.** A visitor's `in` (a pass, a gate request, a field exception) may carry `photoFileId`, a `visitor_photo` upload (images, 5 MB, `gate.operate`). It is stored in `gate_entry_photos`: the entry, the file, the subject, the gate, the unit and who took it.

**Who sees it:**

- the guards on shift, through `/gate/inside` (now `no-store`) and `GET /gate/entries/{id}/photo`;
- the `gate.read` holders.

Never the household, a notification or the audit.

**Deletion.** The photo is deleted 30 days after the entry by the sweep `gate.visitor_photos` (`purge_after` is the entry plus 720 hours: an interval in hours never drifts across a DST change).

- **Deviation:** 30 days after the entry, not the exit. The system closes a visit within 12 hours, and this avoids pairing each `in` with its `out`.
- The sweep takes the row FOR UPDATE SKIP LOCKED. A link in flight holds it FOR SHARE.

**`incident_evidence`.** This table links an incident to what it keeps past its retention:

- a visitor's photo (`visitor_photo`, `entry_id`, a foreign key that restricts the photo's deletion);
- a patrol run's track (`patrol_track`, `run_id`; see 9).

It is insert-only and holds at most 10 pieces per incident (`INCIDENT_EVIDENCE_LIMIT`), each once (`INCIDENT_EVIDENCE_EXISTS`). Evidence is added by the reporting guard on duty (their own run's track only) or by `incidents.manage`, while the incident is not closed. It is kept for as long as the incident, which is forever today. Audit: `incident.evidence_linked`.

### 5. The gate directory

`GET /gate/directory` is for a guard on duty at any post. It lists:

- the active gates, with their kind and the gate's own phone (ADR 0043);
- for each gate and zone, the guards on shift, by first name and last initial (`firstNameRef`, the rule for what guards see of each other, ADR 0050).

Never a personal phone.

### 6. The traffic report, and resident vehicles counted

**The report.** `GET /staff/gate/reports/traffic[?from&to&gateId]` and `/export` (CSV, with the totals last), for `gate.read`. For each compound day and gate it gives:

- the visitors who came in, by pass, gate request or field exception;
- the service vehicles by kind;
- the resident vehicles counted in and out.

Counts only. The range uses `RosterCore.period`: 31 days at most, the last seven by default. Every active gate has a row for every day.

**Resident vehicles (amends ADR 0031): counters, never a log.**

- After the plate lookup finds a registered vehicle, the guard taps in or out: `POST /gate/vehicle-passages`, bodyless idempotency, which answers `{ counted: true }`.
- `gate_vehicle_counts` keeps a count per day, gate and direction, which only grows, by one.
- Nothing else is kept: no vehicle, no time, no audit row naming it. So no resident's movements are logged.

**Deviation:** the route is `/staff/gate/reports/traffic`, next to the gate's other staff routes, not under `/staff/security/reports`.

### 7. The gate log search

**Route and filters.** `POST /staff/gate/log-search`, under the new permission `gate_log.search` (managers only), takes:

- `from` and `to`, required, 31 days at most;
- an optional `unitId`;
- an optional `visitorName`.

It answers the entries without names, newest first, 200 at most (`truncated` says when there were more).

**Deviation: a POST.** The name never sits in a URL or an access log.

- **No idempotency record and no logged body** (the user's change at approval). A test checks that a searched name appears in no idempotency, audit, outbox or log row.
- Rate-limited per account: 20 searches per 10 minutes (429 `RATE_LIMITED`).

**Exact match only.** `visitor_details.name_key` is a generated, indexed column. It folds case and spaces, Arabic letter forms, tashkeel and tatweel, with the same expression as `nameKey()` in code; a spec keeps the two in step. A part of a name or a likeness finds nothing. The key goes with the name, 30 days after the pass or the request, so a name search covers the last 30 days.

**Audit:** `gate.log_searched` with the days, the unit, `byName` (a boolean), the results and `truncated`. Never the name.

### 8. Instructions with validity (amends ADR 0050)

**The days.** `guard_instructions.valid_from` and `valid_until` are optional compound days, inclusive. A CHECK keeps them in order, and they are fixed at sending (the trigger is recreated with them).

- `validUntil` before `validFrom` is `ENDS_BEFORE_START`.
- `validUntil` before today is `DAY_OUT_OF_RANGE` with `params.min`: it would reach nobody.

**The guard sees only what holds today**, in the compound's calendar. That covers the list, the detail, the acknowledgement and the pending count on `/gate/my-work`. On any other day the instruction is 404 to them.

**The management sees each instruction's state:** `scheduled`, `live`, `expired` or `archived`. `?state=` filters by it.

**Told once (`guard_instruction_recipients.notified_at`, set once).**

- At the send: a recipient is pushed only when the instruction holds that day.
- Otherwise: at the guard's first shift start on a day it holds. The existing start hook reaches what applies at the post and has not expired, scheduled ones included, then pushes the untold ones that hold today.
- Someone added at a shift start while it holds is added silently, as before, and counts as told.
- Existing recipients were backfilled as told.

Audit: `guard_instruction.issued` gains `validFrom` and `validUntil` when they are set.

### 9. The patrol geofence (amends ADR 0052)

**The shape.** `patrol_route_versions.geofence` holds `{circle: {lat, lng, radiusM}}` (10–5000 m) or `{polygon: [[lat, lng], …]}` (3–50 vertices, not closed).

- It is kept with what the version says; the trigger is recreated.
- The database CHECKs the shape. The code checks the geometry: exactly one of the two (FIELD_REQUIRED / FIELD_NOT_ALLOWED), and a polygon whose edges cross or that has no area is INVALID_VALUE.
- Audit: the version's audit says `geofence: circle | polygon`, never where.

**Points.** The track upload still takes points only while the run is under way, or for 30 minutes after it ends (the app's offline queue), and only points within the run's lifetime, two minutes either side. So no location is taken outside a patrol. The two minutes absorb the device's clock; the existing tests rely on it.

**Exits (`patrol_geofence_exits`): times only, never a position.**

- Under the run's lock (FOR UPDATE, after the guard's account FOR SHARE), two batches of one run walk one after the other.
- A batch's new points, those after every point walked before, are walked in device-time order. The first point outside opens an exit (`left_at`); the next point inside closes it (`back_at`).
- **"Outside" means further out than the point's accuracy.** A point less precise than 100 m says nothing, either way.
- **Deviation:** a point older than one already walked stays in the track but is not walked. The app sends its queue in order.
- Keys: one exit per (run, `left_at`), and one open exit per run.

**Flagged once (`flagged_at`, `flagged_minutes`).** An exit is flagged when it lasted `geofenceExitMinutes`:

- **by the batch that shows it:** to its return, or to its latest point outside;
- **by the sweep `gate.patrol_geofence`** (every minute), while it is open and no point says more (the user's change at approval): to now, or to the run's end, which caps it. The sweep takes the run FOR UPDATE SKIP LOCKED.

Either way the flag is an update that finds `flagged_at` unset, so it happens once per exit. A flag tells the `patrols.manage` holders with `patrol.geofence_exit` (the run, the minutes). `GET /staff/security/patrols/runs/{id}/geofence-exits` lists them for `patrols.manage`.

**Retention.**

- Points are still deleted 30 days after they were recorded, and at the guard's erasure.
- **They are kept when an incident keeps the run's track** (`incident_evidence` of kind `patrol_track`). The purge goes run by run and takes each run FOR UPDATE SKIP LOCKED: a link holds the run FOR SHARE, and whether a run is kept is read under that lock.
- The guard's export gains `patrols/geofence-exits.json`.

### 10. Recordings on patrol notes and incidents (amends ADR 0029, 0052, 0053)

**Purposes.** Four new file purposes:

| Purpose | Types | Size cap |
|---|---|---|
| `patrol_note_audio` | `audio/mp4` | 20 MB |
| `incident_audio` | `audio/mp4` | 20 MB |
| `patrol_note_video` | `video/mp4`, `video/quicktime` | 100 MB |
| `incident_video` | `video/mp4`, `video/quicktime` | 100 MB |

The MP4 family only (the user's answer). Both file CHECKs were recreated with every purpose. No transcoding.

**Finalize reads the length (`files.media_duration_ms`).**

- The signature check: a `ftyp` box first, brand `qt  ` for QuickTime only.
- The length comes from the `mvhd` box inside `moov`, by ranged reads (`ObjectStorage.range`). The top-level boxes are walked by their headers alone, the media skipped by its size. So a "fast start" file costs two small reads and a file with `moov` at the end one more, then a read of its tail. Never the media.
- **The walk is bounded:**
  - 64 top-level boxes, and 256 inside `moov`;
  - a `moov` of 8 MB at most;
  - every box within its parent and the file;
  - a 64-bit size within safe integers.
- **Refusals, with the file deleted as a mismatch:**
  - a container that cannot be read is 422 `FILE_MEDIA_UNREADABLE`, with `params.reason` one of `box_out_of_bounds`, `too_many_boxes`, `box_too_large` or `bad_movie_header`;
  - one with no movie header is 422 `FILE_MEDIA_NO_DURATION`.
- A CHECK says only a recording has a length, and a finalized recording always does.
- The file view shows `durationMs`.
- Fixtures cover a fast-start file, `moov` at the end, a truncated file, a bogus box size and a file with no movie header.

**Attaching (`patrol_note_media`, `incident_media`, insert-only).** A note takes up to two recordings, `mediaFileIds`; an incident's report takes up to three.

- **The gate's settings bound them when attached:** the megabytes (FILE_TOO_LARGE, `params.maxBytes`) and the seconds (`MEDIA_TOO_LONG`, `params.maxSeconds`). The settings row is read FOR SHARE.
- The kind and the length are copied onto the row.
- Readers see `media: [{kind, durationMs, url, expiresAt}]` where they see the photos: an incident's guard and staff views, a run's detail (a guard sees their own notes' only). A note's view counts them.
- They are kept as their parent is: notes and incidents are kept.
- The incident's audit counts them (`media`), and so does the export.

### 11. Drawn signatures on the incident report (amends ADR 0053)

**The signature.** `POST /gate/incidents/{id}/signatures` (the reporting guard, on duty) and `POST /staff/security/incidents/{id}/signatures` (`incidents.manage`) take a role and an `incident_signature` upload (PNG, 256 KB).

- **`author`** is the one who reported it (otherwise 403 `INCIDENT_SIGNER_NOT_ELIGIBLE`, `params.role`).
- **`reviewer`** is a keeper who did not report it.

`incident_signatures` keeps the signer, the role, the file, the SHA-256 of the report's canonical content for that role when signed, `canonical_version` (1) and the time. It is once per role and content (409 `INCIDENT_ALREADY_SIGNED`).

**Two canonical scopes (the user's change at approval).** Version 1 is sorted-key JSON with sorted ids, ISO instants and null for absent values:

- **author:** the report's fields — number, type, severity, place, unit, when it happened, its words, its author, its links, when it was reported — and its photos', recordings' and evidence's ids;
- **reviewer:** all of that, plus its status, outcome and closing note.

So **closing the incident never supersedes the author's signature, and any change inside a scope supersedes the signatures over that scope.** An assignment or a close supersedes the reviewer's. Evidence linked later supersedes both. An erasure that clears the report's words supersedes the author's.

**Superseded is computed when read**, against the content now, so no row ever changes. A new signature is needed after a change.

**Races.** The signature takes the incident FOR UPDATE, as every write to it does (a close, an assignment, a link). So what is hashed is what was there. A signature racing a close hashes the report either before the close or after it, never between.

**Erasure.** At the signer's erasure the image goes, once: `file_id` becomes null, `image_cleared_at` is set (its trigger allows that alone), and the file is deleted after commit. The hash and the time stay.

**Audit and export.**

- Audit: `incident.signed` (the signature, the role, the version; never the hash's content) and `incident_signature.image_cleared`.
- The signer's export gains `incidents/signatures.json`: the incident's reference, the role, the time and the hash.

### The manager dashboard

**`/security/field-exceptions`** is for `gate_exceptions.decide`.

- The inbox: waiting, answered or expired, all.
- Each exception ticks down to its deadline, and the waiting ones refresh every 10 seconds.
- Approve and reject (with a reason) are available while it can still be answered. An approved exception shows its entry window, and whether it was used.
- The sidebar counts what waits.
- A `gate_exception.requested` notice opens the exception.

**`/security/gate-settings`** is for `gate.manage`: every value with its bounds, and only what changed is sent.

The traffic report and the log search pages wait for M3.

## Privacy

- **Names, plates and ID numbers** never reach an audit row, a notification, the outbox or an idempotency body.
- **A field exception's visitor name** goes with `visitor_details` after 30 days. The ID number shown at a raise is never stored.
- **The log search** keeps the name nowhere, as above.
- **Resident vehicles** are counters only.
- **The visitor's photo** is seen by the gate and the management only, and deleted after 30 days unless an incident keeps it.
- **The geofence** keeps times, never positions, and only for patrols.
- **The directory** shows first names and the posts' phones only.
- **Recordings and signatures** follow their parent's access. A signer's image goes at their erasure.

## New permissions, kinds, purposes and sweeps

- **Permissions:** `gate_exceptions.decide` and `gate_log.search`, both managers only.
- **Notification kinds:**
  - `gate_exception.requested`, `gate_exception.decided` and `gate_exception.expired` (critical);
  - `visit.overstayed` and `visit.overstayed_host`;
  - `patrol.geofence_exit`.
- **File purposes:** `visitor_photo`, `patrol_note_audio`, `patrol_note_video`, `incident_audio`, `incident_video` and `incident_signature`.
- **Reason lists:** `gateExceptionRaise` and `gateExceptionReject`.
- **Sweeps:** `gate.field_exceptions`, `gate.visit_overstay`, `gate.service_vehicle_exits`, `gate.visitor_photos` and `gate.patrol_geofence`. `gate.patrol_track_purge` now skips the runs an incident keeps.

## Deviations (accepted at approval, or noted while building)

1. A field exception goes to every `gate_exceptions.decide` holder, and the first answer wins: there is no duty roster.
2. A visitor's photo is deleted 30 days after the entry, not the exit.
3. The log search is a POST, with no idempotency record and no logged body.
4. An erased signer's image is cleared and its hash kept.
5. The directory shows `firstNameRef` names.
6. Service vehicles have their own table, not `gate_entries` rows, and the plate lookup shows them in their own array.
7. `/gate/inside` is now `no-store`: it carries the visitors' photos.
8. The traffic report is under `/staff/gate/reports`.
9. The daily report's CSV gains `service_vehicles` as its last column.
10. Field-exception visitors count as visitors in the traffic report.
11. The geofence walks only the points after the last one walked.
12. The track keeps its two minutes either side and its 30-minute offline queue.
13. The dashboard's instruction filter still offers live and archived only; the other states come with M3.

## Open

- **The control room (G8):** a live view of exits and field exceptions across posts.
- **A duty roster for the management**, so field exceptions go to whoever is on duty.
- **Offline (O1):** field exceptions, service vehicles and recordings queued on the device.
- **More media containers** (WebM, MP3), each with its own parser.
- **`JWP1.` is two QRs' prefix:** a parcel's (ADR 0035) and an outside escort's pickup (ADR 0054). No lookup confuses them today. Each is parsed only where it belongs: the parcel hand-over looks a `JWP1.` token up in `parcel_credentials` by the `parcel-qr` HMAC; the child's exit looks it up in `child_escorts` by the `child-pickup-qr` HMAC; the entry scanner reads `JWR1.`/`JWR2.` only. The other kind is unknown there, as any wrong QR is (at the parcel desk it counts toward the guard's wrong-code lockout like any other). Their 6-digit codes are kept apart the same way. A scanner that routes by prefix alone, such as an offline bundle, cannot tell them apart: a new prefix for pickups (`JWE1.`, say) would be needed first, with `JWP1.` pickups still read until the last one expires.
