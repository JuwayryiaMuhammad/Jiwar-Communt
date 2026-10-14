# 0043 — The gate card's visitors: a pass read again, group passes, standing instructions, the guard's photo and the gate's phone

**Status:** Accepted · Gate card (visitors)

## Context

The mobile team builds the resident app's Gate card, "Visitors" part, on the visitor passes and gate requests of ADR 0028 and 0030. They asked for what was missing: one pass's detail, its comings and goings, a vehicle plate, a household's standing instructions about uninvited visitors, the guard's photo of a waiting visitor and the gate's phone. They also reported that every recurring pass failed.

Out of scope: vehicles and parking (part B), emergencies and gate services (C, D), the clinic.

## Decisions

### Recurring passes failed because of a schema name, not the format

The code always took recurring windows as times of day (`HH:mm`, in the compound's time zone, an overnight window when `to` is before `from`). But two classes were named `VisitWindowDto`, one in the gate visitors and one in maintenance visits. Swagger keys a component schema by class name, and the maintenance one was read last. So the published contract, the generated client and Postman described a recurring pass's window as a maintenance visit's `{ startsAt, endsAt }`. The mobile client sent exactly that, and `checkSchedule` answered `schedule.windows INVALID_FORMAT` every time.

- The gate classes are now `VisitorScheduleDto` and `VisitorWindowDto`, and the schedule is validated nested. An unknown key is reported as `FIELD_NOT_ALLOWED` and a malformed time as `INVALID_FORMAT`, each on its own field (`schedule.windows.0.from`).
- The same collision documented the primary's decision on a deferred action (`POST /deferred-actions/{id}/decide`: `approve | decline`, with a reason) as the gate's `approve | deny`. The classes are now `GateDecisionDto` and `PermissionDecisionDto`. `RequestMessageCreatedView` and `SuggestionBoardQueryDto` were duplicates of the same shape, and are renamed anyway.
- A unit test fails when two contract classes share a name.
- The format does not change and no data moves. No recurring pass could be created, so none exists.

### A pass's token is derived, so the pass can be read again

ADR 0030 issued a random token and forgot it: the code, the QR and the link came once. A pass's detail must show them again to those who manage it, so the token is now derived, as a parcel's is (ADR 0035): `base64url(HMAC-SHA256(VISITOR_PASS_TOKEN_KEY, "pass:<tenant>:<passId>:<seq>"))`.

- `visitor_passes.token_seq` is the live number. A new code is the next number: a reissued link, a replayed create, or a code already taken by another active pass.
- The server still stores only the HMACs of the code and the token. The gate and the public page cannot tell a derived token from a random one.
- The detail derives the secret and shows it only while it matches the stored hash. A pass issued before this change, or one whose key was rotated, shows `code: null`. Its code still opens the gate, and reissuing the link gives a derived one.
- `VISITOR_PASS_TOKEN_KEY` is required at boot: at least 32 characters, never equal to `IDENTIFIER_PEPPER`, `ENTRY_CREDENTIAL_KEY`, `PARCEL_TOKEN_KEY` or `ENGAGEMENT_REF_SECRET`, and different per environment. Rotating it hides the codes of the passes active at the time and invalidates nothing.

### `GET /visitor-passes/{id}`

- **Who reads it:** any member of the unit (`capabilities.unitView`). An unknown pass and another unit's pass get the same `VISITOR_PASS_NOT_FOUND`.
- **The secrets** (`code`, `qrPayload`, `link`), while the pass is active, go to those who may manage the pass: its host while still placed on the unit, and the unit's primary. These are the people who may already cancel it or reissue its link.
- **The visitor's data** (`visitorName`, `visitorPhoneMasked` as `••••` and the last four digits, `vehiclePlate`) goes to the host only, as on the list.
- `createdBy`, `enteredAt`, `exitedAt` and `entriesUsed` go to every reader. The response is `no-store`.
- The unit's list keeps its rule: the primary sees every pass, and anyone else who may invite sees their own.

### Comings and goings

- `enteredAt` is the latest `in` on the pass.
- `exitedAt` is the latest `out`, once as many have left as came in; it is null while anyone is inside.
- One grouped query reads them for a page.
- The status is the named enum `VisitorPassStatus`. Each value is described in the contract.

### A group pass lets in one person per entry

- **Before:** `partySize` was only a label. One entry let the whole group in and used a one-time pass. Anyone who arrived later was refused (`used`), and nobody could come in again before an exit (`ALREADY_INSIDE`).
- **One-time pass:** one code for `partySize` people. Each `in` is one person, counted in `visitor_passes.entries_used` under the pass's row lock, the lock every entry takes at every gate. When the count reaches `partySize`, the pass is `used` and its code and QR die. Until then, the same code lets the rest in at any gate until `validUntil`.
  - CHECKs: `0 ≤ entries_used ≤ party_size`, and `status = used` exactly when a one-time pass is full.
  - Passes used before this change let their whole group in on one entry, and count as full.
- **Recurring pass:** counts nothing; `partySize` caps how many are inside at once, on every visit.
- **Inside is a count:** `in`s less `out`s.
  - An exit closes the oldest open entry.
  - `GET /gate/inside` shows `insideCount`.
  - The unconfirmed-exit sweep closes everyone still inside, one exit each.
- **Verify:** `next` is `in` while there is room and the pass is valid, and `out` while anyone is inside. `display` carries `entriesUsed` and `insideCount`. An entry on a full one-time pass is `GATE_ENTRY_REFUSED` with reason `used`.
- **Workers and approvals:** stay one person, in or out.
- `POST /gate/entries` takes one person per call. A `count` for a group arriving together is not built.

### A vehicle plate

- Optional on create.
- **Format:** Arabic letters, Latin letters, Western or Arabic-Indic digits, and spaces.
- **Tidied:** trimmed, runs of spaces made one, Latin letters upper-cased. At most 12 characters after that; otherwise `INVALID_FORMAT` with `maxLength`.
- **Stored** on `visitor_details` with the name and the phone, and deleted with them 30 days after the pass ends.
- **Shown to:** the host (list and detail) and the guard, on a valid pass's verify. The host's export lists it.

### Standing instructions

`unit_standing_instructions` is a new tenant table, under RLS, forced. Each row is a few words (1–140 characters) about someone who may come without a pass, with what the guard does then:

- `always_allow`: the guard lets them in and logs the entry;
- `never_allow`: the guard turns them away;
- `call_first`: the household answers the gate request;
- `leave_at_gate`: what they bring is left at the gate.

Rows are created and deleted, never updated.

- **Who:** those who may invite visitors on the unit (`capabilities.visitorsInvite`) write and read them, 20 per unit at most. An instruction is deleted by its author or by the unit's primary; another inviter gets 403. Create takes an `Idempotency-Key`.
- **An instruction speaks for the unit only while its author may still invite there.** If the author left, lost `visitors_invite`, or was deactivated or frozen, the guard never sees the instruction and cannot apply it. The household still lists it, so the primary can delete it. This follows the pass rule of ADR 0028: a pass is valid while its host may invite.
- **What the guard sees:** on a waiting uninvited-visitor or delivery request, its `standingInstructions` (id, description and action, never who wrote them), while the request is pending.
- **What the guard does:** `POST /gate/approval-requests/{id}/apply-instruction` decides the request by one instruction, under the request's lock, as a household decision would.
  - `always_allow` approves it, `never_allow` denies it, and `leave_at_gate` leaves the delivery at the gate. The source is `standing_instruction`, and the audit entry names the instruction.
  - The entry is then recorded on the request as always, so the guard still logs every entry.
  - `call_first` decides nothing (`STANDING_INSTRUCTION_CALL_FIRST`), and a worker off schedule is the household's own question (`STANDING_INSTRUCTION_NOT_APPLICABLE`).
- **`allowAlwaysAllow`:** a compound setting, on by default, editable in `PATCH /settings` and on the manager dashboard.
  - While it is off, no `always_allow` is written (`ALWAYS_ALLOW_DISABLED`).
  - The guard sees the existing ones as `call_first`.
  - Residents see the stored `action` and the `effectiveAction` the guard sees.
- **Personal data:** the description never goes into the audit trail (`standing_instruction.created` and `.deleted` carry the unit and the action) or into a notification. The author's erasure deletes the rows (reason `author_erased`). The author's export lists them (`standing-instructions.json`).
- **The gate-instructions of ADR 0028 are unchanged.** They still decide a request nobody answers in time.

### The guard's photo, the gate's phone

- **The photo:** a new file purpose, `gate_request_photo` (images, 5 MB, uploaded by `gate.operate`). The guard passes it as `photoFileId` when creating a request of any kind; it is claimed and attached in the request's transaction.
  - Its `photoUrl` is a presigned URL valid for `S3_URL_TTL_SECONDS` (300 s by default).
  - The household asked (`/me/gate-requests`) and the guard (the request views) see it. Those responses are now `no-store`.
  - The `gate.request_photos` sweep deletes it 7 days after the decision: the pointer first, then the file (reason `retention`).
- **The gate's phone:** `gates.phone` (E.164, checked by the database), set by the manager on `POST` and `PATCH /gates` (`null` removes it).
  - It shows on the manager's gate views, on `GET /gates/status`, and as `gatePhone` on `/me/gate-requests`.
  - The audit records it as changed only, like every phone.

### The push for a new request

It already existed: `gate.approval_requested` goes to the unit's `visitorsInvite` holders, with a generic text and no visitor name on the lock screen. It stays **critical**, as ADR 0036 decided: a visitor waits at the gate, and a muted request would only time out.

## Consequences

- Five migrations (`20261021090000` to `20261021090400`), one new tenant table, six new CHECKs, reviewed in the CHECK map.
- A new required environment variable, `VISITOR_PASS_TOKEN_KEY`, which staging must set before deploying.
- Routes:
  - New: `GET /visitor-passes/{id}`, `GET`/`POST /units/{unitId}/standing-instructions`, `DELETE /units/{unitId}/standing-instructions/{id}`, `POST /gate/approval-requests/{id}/apply-instruction`.
  - Changed: pass create, list and verify, entries, inside, gate requests, gates and settings.
- Group semantics change the guard's flow: a group comes in one entry per person.
- The manager dashboard gains the `allowAlwaysAllow` toggle and the gate phone.

## Open

- A `count` on `POST /gate/entries` for a group that arrives together.
- No notification tells a household that a visitor came in on its `always_allow` instruction; the entry log has it.
- Residents have no history of decided gate requests, so the photo is visible only while a request waits.
- Visitor parking and the visitor's route inside the compound come with the Vehicles phase.
