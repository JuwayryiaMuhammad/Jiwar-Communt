# 0068 — The guard's vendors: face checks at the gate, ID scans, the control room's channel, guard-down alarms and masked calls from the gate, each behind a driver chosen by env

**Status:** Accepted · G8 · amends ADR 0053 (the blocklist's sources), 0056 (its Open control room; the gate's settings), 0067 (the staff's SOS core takes a reporter)

## Context

ADR 0056 and 0057 left five pieces of the guard's work to G8: face recognition, ID OCR, masked calling, man-down and the control room. Each needs a vendor, and no contract is signed yet. G8 builds every rule on our side behind a seam, so a vendor is plugged in later as a driver. H1 (ADR 0056's lock order for every guard write) shipped first and every write here follows it. M1-3b (ADR 0067) split the staff's SOS core out of the guard's; the alarm raises through it.

## Decisions

### The seam

- **A driver per vendor**, chosen by env: `GATE_FACE_DRIVER`, `GATE_ID_SCAN_DRIVER`, `GATE_CALL_DRIVER`, `GATE_ALARM_DRIVER`, `CONTROL_ROOM_DRIVER`, each `fake | off`.
  - Unset: the fake outside production, off in production.
  - **A fake is refused at boot in production** (env.schema), so a fake never runs where real residents are. Staging runs `NODE_ENV=production`: G8 is off there, and mobile developers test against local compose.
  - The fakes live in `src/`, deterministic and scriptable (fail the next call, hold one), unlike Paymob's test-only fake: a developer's compose runs them.
- **Our code holds the rules; the driver only talks.** A driver call never runs inside a database transaction: a write records what it is about to ask, the vendor is called, a second transaction records the answer under the locks again.
- **A driver's failure** is `503 VENDOR_UNAVAILABLE {service}` (`reason: 'off'` for an off driver), bounded by `GATE_VENDOR_TIMEOUT_MS` (5 s); never the vendor's words.
- **No credentials in env.** A real driver will read the compound's own from the credential vault (ADR 0046's pattern). The fakes sign their webhook calls with a key written in the code: harmless only because a fake never runs in production.
- **Webhooks** (alarms, calls) keep the Paymob webhook's rules (ADR 0046) in one helper: the driver's signature authenticates; every refusal is the same 401 and counts against the IP; a failed signature is a security event (`guard_alarm.webhook_rejected`, `gate_call.webhook_rejected`, compound only); an off driver answers 404; a failure 500, so the vendor calls again — its event id makes that a no-op. A driver checks the parsed JSON body; one that needs the raw bytes will need the app's raw body turned on.
- **Sweeps that call a vendor** claim their rows on a lease (`leased_until`), call between two transactions (`SweepRunner.forEachTenantCall`) and back off on failure, doubling, to an hour.

### Face checks at the gate

- **Advisory only, 1:N against the blocklist.** The gallery is the blocklist's live person entries with a photo. A possible match is the guard's to judge and the keepers' to hear of; nobody is refused by a face alone; the vendor's score is never shown or kept.
- **Each compound opts in** (`gate_settings.face_checks`, off), a manager action under `gate.manage`, audited (`gate_settings.changed`). **It turns on only with the management's word that a visible notice is posted at the gate** (`faceChecksNoticePosted: true`, kept in the audit's metadata). A face template is sensitive data under Egypt's data protection law (Law 151/2020); the compound carries the lawful basis and the notice.
- **The gallery is an outbox** (`gate_face_enrollments`), written in the blocklist entry's transaction under the blocklist lock, the settings read FOR SHARE:
  - a live person entry with a photo has one live enrolment (pending, then enrolled) while the switch is on;
  - a lift, an expiry, the 30-day purge, a cleared or replaced photo, or the switch turned off moves it to `removing` (a replaced photo starts a new one);
  - the sweep `gate.face_enrollment` enrols and removes on a lease, so an enrolment never has two calls in flight. **Removal goes by the enrolment's id** (the vendor's external id), so even an enrolment whose answer was lost to a timeout leaves no template.
- **`POST /gate/face-checks {photoFileId}`** (`gate.operate`, on shift at a gate, the guard's rate limit, Idempotency-Key):
  - the account, then the shift, FOR SHARE; the probe (`gate_face_probe`) claimed; the check written pending;
  - the vendor searched outside any transaction;
  - the locks again; the answer: `no_match`, `possible_match` (each live entry recorded as met, source `face`, `noted`, tied to the check; the keepers told; the control room told), or `unavailable` (the vendor failed: the guard goes on by hand — answered 201 with that outcome, not 503, so the check and its replay agree).
  - A shift that ended in between leaves the check unanswered and nothing met.
- **The probe goes** after a day, or 30 days after a possible match (as a visitor's photo); the check keeps its answer. `GET /gate/face-checks/{id}`: the guard's own.

### ID scans

- **`POST /gate/id-scans {imageFileId}`** (`gate.operate`, on shift at a gate, rate-limited, no-store, no idempotency record): the vendor reads the document; our checks run on what it read — the number normalized as an ID lookup takes it, a national ID's own structure (a real birth date, a known governorate), expiry by the compound's today — and the number meets the blocklist as an ID lookup's does (`id_scan`, noted).
- **What was read goes to the guard's device once**, to fill a gate request: never stored, never in an audit row (`gate.id_scanned` holds the outcome, the document's type and whether it met an entry), a notification, the outbox or a log (request bodies are never logged). A trail test checks it.
- **The image (`gate_id_scan`) is deleted whatever came of it**, at once, and by `gate.id_scan_orphans` if the process died in between. `422 ID_SCAN_UNREADABLE`: type the number. No table.

### The control room's channel

- **`control_room.watch`** (staff and manager kinds), the security supervisor's by default; a control room's own role later takes the same permission. The permission sync gives it to existing compounds.
- **An outbox** (`control_room_events`), written by each source in its own transaction: an event exists exactly when its cause committed. Ids and codes only.
  - Sources: a guard's SOS raised and escalated, a guard alarm (paired or not), a lockdown started and ended, the blocklist met at the gate (face and ID scans included; a ban as an alert), a field exception raised, a patrol's geofence exit flagged, a gate device out of sync, a gate call missed.
  - The watchers are told in the same transaction, the actor never: **`control_room.alert`** (critical) for an SOS, an alarm, a lockdown started or a ban met; **`control_room.event`** otherwise. (Criticality is per kind, so two kinds.)
- **`GET /staff/control-room/events`** (`status=open|acknowledged`), `/{id}`, **`POST …/{id}/acknowledge`** once under the row lock (`409 CONTROL_ROOM_EVENT_ACKNOWLEDGED {acknowledgedAt}`).
- **`GET /staff/control-room/posts`** — ADR 0056's Open item: each active gate and each zone on duty, its open shift and guard, whether the guard wears a paired device, whether it is locked down, its waiting field exceptions and open staff SOS.
- **Delivery:** `gate.control_room_delivery` sends each event to the vendor at least once, keyed by its id; `skipped` while the driver is off.

### Guard-down alarms

- **Wearables:** `gate_devices.manage` registers a vendor's device by its reference (one live device each), renames it, retires it once with an `alarmDeviceRetire` code. A guard on shift (gate or zone) pairs one for the shift: one open pairing a device and one a guard; a re-pair ends the old; the shift's end, an unpair or a retirement ends it.
- **`POST /public/gate/alarms/{compoundId}`**, the vendor's webhook: `{eventId, deviceRef, kind: fall|no_motion|panic|cancelled, at}`, `at` within ±24 h. Each (device, vendor event) is taken once under a lock of its own; every event is kept (`guard_alarm_events`, immutable) with what came of it.
- **A paired device on an open shift raises the guard's SOS for them** through the staff's SOS core (ADR 0067), from the shift's post: a panic as `security`, a fall or stillness as `medical` — no new emergency type, no change to `emergencies`. It keeps the core's one open emergency a post and type (a second device at the post joins it), its telling (the guard never told of their own) and its escalation. Locks as the guard's own SOS takes them: the guard's account, then the shift, FOR SHARE, then the device, then the post's emergency lock.
- **The core takes a reporter.** A webhook has no signed-in caller, so `SosCore.raiseLocked` and `requestCancelLocked` take an optional last `reporterId` (the paired guard): the emergency's reporter and the notices' sender. Its audit actor stays the system: the device raised it.
- **Unknown, unpaired, retired, or its shift ended:** the control room only (`guard_alarm_unpaired`), never dropped.
- **The vendor's `cancelled`** asks for the device's last open emergency to be called off — recorded and told — and it stays open for a responder (someone under duress can be made to cancel).

### Masked calls from the gate

- **In-app voice only**, through the vendor's rooms: no phone number reaches the vendor or the guard. Participants are opaque to the vendor (the call's own refs, never an account).
- **`POST /gate/calls {unitId, reasonCode, approvalRequestId?}`** (`gate.operate`, on shift at a gate, Idempotency-Key): the account, the shift, the unit's call lock; one live call a guard and a unit (`409 GATE_CALL_LIVE {callId}`); the household members a gate request goes to (`visitorsInvite`) rung critically (`gate.call_incoming`: the gate and a code); the room opened after the commit (a vendor down ends the call `unavailable`, 503).
- **The guard:** `GET /gate/calls/{id}` (answered or not — never who), `POST …/join` (a short-lived token, no-store), `POST …/end`.
- **The household:** `GET /me/gate-calls/{id}`, `POST …/answer` (the first under the call's row lock; another is `409 GATE_CALL_ANSWERED`; the answerer may ask again for a token), `…/decline` (it ends for everyone), `…/end`.
- **Time:** a call rings for `gate_settings.call_ring_seconds` (45; 15–120), then is missed and the control room hears; answered, it lasts at most `call_max_seconds` (300; 60–900) — sweep `gate.call_timeouts`. The guard's shift ending ends their live calls. A call's room is closed after it ends, by `gate.call_rooms` if the vendor did not answer then. A room the vendor closed (its webhook, `POST /public/gate/calls/{compoundId}/events`) ends the call.
- Gate calls are never subject to a unit's suspension (resident entry and visitors are not).

### Lists, permissions, notices

- **File purposes:** `gate_face_probe`, `gate_id_scan` (images, 5 MB, the guard's).
- **Reason lists:** `alarmDeviceRetire`, `gateCallReason`.
- **Notification kinds:** `control_room.alert` (critical), `control_room.event`, `gate.call_incoming` (critical).
- **Audit:** `face_check.made`, `face_enrollment.enrolled|removed`, `gate.id_scanned`, `control_room_event.acknowledged`, `guard_alarm_device.registered|renamed|retired`, `guard_alarm.paired|unpaired|received`, `gate_call.started|answered|ended|missed`; security events `guard_alarm.webhook_rejected`, `gate_call.webhook_rejected`. Ids, codes and counts: never a face, a template, a score, a document's number, a name or who answered a call.
- **The blocklist's matches** gain the sources `face` and `id_scan` and the subject `face_check`.
- **Manager pages:** the control room, the alarm wearables, and the gate's settings with the call times and the face-check switch.

## Consequences

- Six migrations (`20261229090000`…`090500`); every table RLS FORCE with composite keys, moves-forward triggers and the grants its locks need.
- G8 is off on staging until a vendor's driver and its contract arrive.
- A guard's own SOS is the control room's alert when `GuardSosService` makes a new one (a repeat, the open one, is not); escalated, it is another.

## Open

- **Real drivers**, one per vendor, with their credentials in the vault; raw request bodies if a vendor signs bytes.
- **1:1 face checks** against residents' own photos, with their consent.
- **A phone-network fallback** for calls, as a driver capability.
- **A phone's own fall detection** as a second alarm source, through ADR 0057's signed device envelope.
